/**
 * Run a learner's code in the browser: the page's door to the runner.
 *
 * The runtimes ship with the app (no CDN, nothing downloaded from anywhere
 * else) and are fetched from this app's own address the first time a code
 * question is run, then kept for the session. Each job gets a fresh frame
 * (./frameHost.ts). Python takes a few seconds to start, so after the first
 * Python job one frame is started ahead and kept ready for ten minutes; it has
 * run nothing but the runtime itself until a job arrives.
 *
 * This module is loaded only when a code question is graded or run, so the
 * app's first load does not carry it.
 */
import quickjsWasmUrl from '@jitl/quickjs-ng-wasmfile-release-sync/wasm?url';
import pyodideWasmUrl from 'pyodide/pyodide.asm.wasm?url';
import pyodideStdlibUrl from 'pyodide/python_stdlib.zip?url';
import { RUNNER_LIMITS } from '../../server/runnerFrame.js';
import { openRunnerFrame } from './frameHost';
import type { FrameBoot, RunnerFrame } from './frameHost';
import { MEMORY_MB } from './languages';
import type { CodeTest, RunPhase, RunResult, RunnerLanguage } from './protocol';

const SPARE_IDLE_MS = 10 * 60_000;

const bytes = new Map<string, Promise<Uint8Array>>();
function bytesOf(url: string): Promise<Uint8Array> {
    let p = bytes.get(url);
    if (!p) {
        // A download that stalls ends at the start-up limit, body included: a
        // promise left pending here would hold "Starting…" on screen, and every
        // later run would wait on the same one.
        p = fetch(url, { signal: AbortSignal.timeout(RUNNER_LIMITS.loadMs) }).then(async (res) => {
            if (!res.ok) throw new Error(`runner: ${res.status} for ${url}`);
            return new Uint8Array(await res.arrayBuffer());
        });
        // A failed fetch is not kept: the next run asks again.
        p.catch(() => bytes.delete(url));
        bytes.set(url, p);
    }
    return p;
}

async function bootFor(language: RunnerLanguage): Promise<FrameBoot> {
    const worker = (await import('virtual:runner-worker')).default;
    if (language === 'python') {
        const [loader, asm, lock, wasm, stdlib] = await Promise.all([
            import('pyodide/pyodide.mjs?raw'),
            import('pyodide/pyodide.asm.mjs?raw'),
            import('pyodide/pyodide-lock.json?raw'),
            bytesOf(pyodideWasmUrl),
            bytesOf(pyodideStdlibUrl),
        ]);
        return {
            worker,
            payload: {
                language,
                memoryMb: MEMORY_MB.python,
                files: {
                    'pyodide.mjs': loader.default,
                    'pyodide.asm.mjs': asm.default,
                    'pyodide-lock.json': lock.default,
                    'pyodide.asm.wasm': wasm,
                    'python_stdlib.zip': stdlib,
                },
            },
        };
    }
    return {
        worker,
        payload: { language, memoryMb: MEMORY_MB.javascript, files: { 'quickjs.wasm': await bytesOf(quickjsWasmUrl) } },
    };
}

let spare: { language: RunnerLanguage; frame: RunnerFrame; expire: ReturnType<typeof setTimeout> } | null = null;
let spareStarting = false;
/** Bumped when the runner is switched off: a frame started before it is not kept. */
let generation = 0;

/**
 * A runtime that could not start is remembered for a minute, so grading a
 * sitting with several code questions does not wait out the start-up limit
 * once per question. A Run the learner presses always tries again.
 */
const DOWN_MS = 60_000;
const downUntil = new Map<RunnerLanguage, number>();

function takeSpare(language: RunnerLanguage): RunnerFrame | null {
    if (!spare || spare.language !== language) return null;
    clearTimeout(spare.expire);
    const { frame } = spare;
    spare = null;
    if (!frame.isOpen()) { frame.dispose(); return null; }
    return frame;
}

/**
 * Start a Python frame ahead: after a job, for the next one, and when the
 * learner starts writing Python, so the first Check does not wait for it.
 */
export function warmRunner(language: RunnerLanguage, delayMs = 1000) {
    startSpare(language, delayMs);
}

function startSpare(language: RunnerLanguage, delayMs = 1000) {
    if (language !== 'python' || spare || spareStarting) return;
    spareStarting = true;
    const started = generation;
    setTimeout(() => {
        if (started !== generation) { spareStarting = false; return; }
        bootFor(language)
            .then((boot) => {
                if (started !== generation) return;
                const frame = openRunnerFrame(boot);
                const expire = setTimeout(() => {
                    if (spare?.frame === frame) spare = null;
                    frame.dispose();
                }, SPARE_IDLE_MS);
                spare = { language, frame, expire };
                frame.ready.then((failed) => {
                    if (failed && spare?.frame === frame) { clearTimeout(expire); spare = null; }
                });
            })
            .catch(() => { /* the next job starts its own frame */ })
            .finally(() => { spareStarting = false; });
    }, delayMs);
}

/** Close the frame kept ready, if any (the setting was switched off). */
export function closeSpareRunner() {
    generation++;
    if (!spare) return;
    clearTimeout(spare.expire);
    spare.frame.dispose();
    spare = null;
}

async function runJob(
    language: RunnerLanguage,
    job: { mode: 'run' | 'check'; learner: string; reference?: string; tests: CodeTest[] },
    onPhase?: (phase: RunPhase | 'starting') => void,
): Promise<RunResult> {
    if (job.mode === 'check' && Date.now() < (downUntil.get(language) ?? 0)) return { status: 'unavailable', phase: 'load' };
    const started = generation;
    let frame = takeSpare(language);
    if (!frame) {
        onPhase?.('starting');
        let boot: FrameBoot;
        try {
            boot = await bootFor(language);
        } catch (err) {
            downUntil.set(language, Date.now() + DOWN_MS);
            return { status: 'unavailable', phase: 'load', error: String((err as Error)?.message ?? err).slice(0, 300) };
        }
        frame = openRunnerFrame(boot);
    }
    const failed = await frame.ready;
    if (failed) {
        downUntil.set(language, Date.now() + DOWN_MS);
        return failed;
    }
    downUntil.delete(language);
    const result = await frame.run(job, onPhase);
    if (started === generation) startSpare(language);
    return result;
}

/** The learner's code on its own, with the question's first test as input. Nothing is graded. */
export function runCode(language: RunnerLanguage, learner: string, tests: CodeTest[], onPhase?: (phase: RunPhase | 'starting') => void) {
    return runJob(language, { mode: 'run', learner, tests: tests.slice(0, 1) }, onPhase);
}

/** The reference, then the learner's code, on every test; one row per test. */
export function checkCode(language: RunnerLanguage, reference: string, learner: string, tests: CodeTest[], onPhase?: (phase: RunPhase | 'starting') => void) {
    return runJob(language, { mode: 'check', learner, reference, tests }, onPhase);
}
