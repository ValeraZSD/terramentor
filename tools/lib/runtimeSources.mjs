// What a package of the app has to carry besides its two programs.
//
// The app that runs is server/ (the API and the page) and mcp/ (the MCP
// server an agent in another app starts). Both are copied whole. But server/
// also imports a few files from src/: the card scheduler and the card-text
// helpers the page uses, so a card rated through an agent is scheduled by
// the same code as one rated in the app. A package without them does not
// start. And the MCP views read the app's translations by path at runtime,
// which no import names.
//
// Only STATIC imports count. A lazy `import()` is how server/ reaches a file
// a package may leave out on purpose: desktop/lib.js and desktop/updateCore.js
// are loaded that way because the Docker image ships no desktop/ folder.
//
// tools/build-desktop.mjs copies what `runtimeSources()` returns, and
// tools/desktop-gates.mjs holds the Dockerfile to the same list, so a new
// import from src/ reaches both packages or fails a gate, rather than
// failing the first start of a release.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';

/** The folders shipped whole. */
export const RUNTIME_DIRS = ['server', 'mcp'];

/** Read by path at runtime (mcp/views.js), so no import names it. */
export const RUNTIME_DATA = ['src/locales'];

// What a checkout keeps inside server/ that is state, not code: the dev
// library's blob store, its logs, the desktop launcher's browser profile
// (hundreds of extension .js files).
const NOT_CODE = new Set(['vault', 'logs', 'browser-profile', 'node_modules']);

// `from 'x'` after an import or export, and a bare `import 'x'`, each at the
// start of a line so prose in a comment cannot match. `import type` is erased
// by Node before the module runs, so it loads nothing.
const STATIC_IMPORT = /^\s*(?:(?:import(?!\s+type\b)|export)\b[^;]*?\bfrom\s*|import\s*)['"]([^'"]+)['"]/gm;
const CODE = /\.(js|mjs|cjs|ts)$/;

/** Every module under one folder, as absolute paths. */
export function codeFiles(dir) {
    const out = [];
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (!NOT_CODE.has(name)) out.push(...codeFiles(p));
        } else if (CODE.test(name)) out.push(p);
    }
    return out;
}

/**
 * The files outside RUNTIME_DIRS that the modules in them import statically,
 * followed through their own relative imports: repo-relative paths with `/`,
 * sorted.
 */
export function runtimeSources(repoRoot) {
    const root = resolve(repoRoot);
    const inside = RUNTIME_DIRS.map((d) => join(root, d) + sep);
    const isRuntime = (p) => inside.some((d) => p.startsWith(d));
    const found = new Set();
    const queue = RUNTIME_DIRS.flatMap((d) => codeFiles(join(root, d)));
    while (queue.length) {
        const file = queue.shift();
        const src = readFileSync(file, 'utf8');
        STATIC_IMPORT.lastIndex = 0;
        let m;
        while ((m = STATIC_IMPORT.exec(src))) {
            const spec = m[1];
            if (!spec.startsWith('.')) continue;
            const target = resolve(dirname(file), spec);
            if (isRuntime(target) || found.has(target)) continue;
            const from = relative(root, file);
            if (!target.startsWith(root + sep)) throw new Error(`${from} imports ${spec}, outside the repository`);
            if (!existsSync(target)) throw new Error(`${from} imports ${spec}, which does not exist`);
            found.add(target);
            if (CODE.test(target)) queue.push(target);
        }
    }
    return [...found].map((p) => relative(root, p).split(sep).join('/')).sort();
}
