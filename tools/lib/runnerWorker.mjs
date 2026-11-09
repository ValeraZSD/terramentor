// Bundles the code runner's worker (src/runner/worker.ts) into ONE string.
//
// The worker is started inside the runner frame from a blob: the frame's origin
// is opaque, so it cannot load a worker by this app's address, and a blob
// worker inherits the frame's policy, which is the point. So the page needs the
// worker as text: the Vite plugin (tools/vite-plugin-runner.mjs) serves this as
// `virtual:runner-worker`, and tools/code-runner-gates.mjs builds the same
// bundle to run in a real browser. QuickJS's glue is bundled in; the runtimes'
// big files (Pyodide's, QuickJS's wasm) are not: the page hands them over.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RUNNER_WORKER_ENTRY = join(repoRoot, 'src', 'runner', 'worker.ts');

/** `{ code, inputs }`: the bundle's text and the absolute paths it was built from. */
export async function buildRunnerWorker({ minify = true } = {}) {
    const out = await build({
        entryPoints: [RUNNER_WORKER_ENTRY],
        bundle: true,
        // A classic script: Chromium refuses a MODULE worker made from a blob
        // in an opaque-origin frame ("Refused to cross-origin redirects of the
        // top-level worker script"), and runs a classic one.
        format: 'iife',
        // QuickJS's glue resolves its wasm against its own address; the wasm
        // is handed over as bytes, so the address only has to parse.
        define: { 'import.meta.url': '"https://runner.invalid/quickjs/"' },
        platform: 'browser',
        target: 'es2022',
        minify,
        write: false,
        metafile: true,
        legalComments: 'eof',
        logLevel: 'silent',
        absWorkingDir: repoRoot,
    });
    return {
        code: out.outputFiles[0].text,
        inputs: Object.keys(out.metafile.inputs).map((p) => resolve(repoRoot, p)),
    };
}
