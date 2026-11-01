// Bundle one of the app's TypeScript modules with esbuild and import it, for a
// suite that drives the real source rather than a copy of it.
//
// The one legitimate skip is a machine without esbuild: then this prints a
// `SKIPPED:` line (which tools/run-gates.mjs accepts) and returns null. Any
// other failure throws: a source that does not build, a module that throws on
// import (a browser-only line at its top level, say), or an export the suite
// calls that is no longer there. A catch-all here once turned exactly those
// into a green suite whose checks had quietly gone, with a message blaming
// esbuild.

import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * @param {string} entry      path from the repository root, e.g. 'src/utils/tree.ts'
 * @param {string} outDir     a scratch directory the bundle is written into
 * @param {{ what: string, needs?: string[], [option: string]: unknown }} opts
 *        `what` names the section in the SKIPPED line, `needs` lists the
 *        exports the suite calls; anything else is passed to esbuild.
 */
export async function bundleTs(entry, outDir, { what, needs = [], ...options }) {
    let build;
    try {
        ({ build } = await import('esbuild'));
    } catch (err) {
        if (err.code !== 'ERR_MODULE_NOT_FOUND' || !/esbuild/.test(err.message)) throw err;
        console.log(`SKIPPED: ${what} — esbuild unavailable (${String(err.message).split('\n')[0]})`);
        return null;
    }
    // fileURLToPath/join, never a URL's `.pathname`: a checkout path may hold a
    // space, which stays percent-encoded there and esbuild cannot resolve it.
    const outfile = join(outDir, `${basename(entry).replace(/\.tsx?$/, '')}.mjs`);
    await build({
        entryPoints: [join(repoRoot, entry)],
        bundle: true, format: 'esm', outfile, logLevel: 'silent',
        ...options,
    });
    const mod = await import(pathToFileURL(outfile).href);
    const missing = needs.filter((name) => !(name in mod));
    if (missing.length) throw new Error(`${entry} no longer exports ${missing.join(', ')} (${what})`);
    return mod;
}
