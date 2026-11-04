/**
 * The document a learner's code runs behind (src/runner/).
 *
 * Code answers are run in the learner's browser, never here. The page loads
 * this shell in an iframe sandboxed to `allow-scripts` alone, so the shell's
 * origin is opaque: it shares no cookie, storage or address with the app, and
 * the app's API refuses its requests (originGuard turns away origin `null`).
 * The shell runs nothing it is sent. It starts ONE worker from the source the
 * page hands it, passes the runtime files (Pyodide, QuickJS) and then the job
 * across, and relays the worker's answer back over a MessagePort; the code
 * itself only ever runs inside that worker.
 *
 * The walls are the browser's own, and all of them are in the policy below,
 * which a blob worker inherits from the document that made it:
 *   - no address of any kind: `default-src 'none'` and `connect-src 'none'`
 *     refuse fetch, XHR, WebSocket, EventSource and every subresource, so the
 *     code can reach neither the internet, the home network nor this app;
 *   - script only from the one inline bootstrap below (by its hash) and from
 *     `blob:`, which is how the worker and the runtimes' own modules arrive;
 *     `'unsafe-eval'` because Pyodide evaluates its own glue as it starts, and
 *     `'wasm-unsafe-eval'` to compile the two runtimes. Neither reaches the
 *     page: a frame's policy governs the frame alone, and the page keeps its
 *     `script-src 'self'`;
 *   - framed only by this app, and a sandbox of its own, so the shell opened
 *     in a tab is as cut off as it is in the frame.
 *
 * Time is the shell's job: the worker is terminated when the runtime has not
 * started within `loadMs`, or when a phase (the reference solution, then the
 * learner's code) runs past `runMs`. Terminating a worker stops a busy loop,
 * wasm included, which the interpreters' own interrupt hooks do not
 * reliably do. The page holds a second timer a little longer than each of
 * these and removes the whole frame if the shell itself stops answering.
 *
 * No imports: the client reads the path and limits from this file too.
 */

export const RUNNER_FRAME_PATH = '/runner.html';

/**
 * How long each stage may take, in milliseconds. `loadMs` covers starting a
 * runtime (Python takes about 3 s on a desktop, longer on a phone); `runMs`
 * each phase of a job; `graceMs` is how much longer the PAGE waits than the
 * shell before it removes the frame; `maxMessages` how many messages the
 * worker may send before the shell stops it as a flood (the glue sends at
 * most four: ready, reference, learner, result).
 */
export const RUNNER_LIMITS = Object.freeze({ loadMs: 30000, runMs: 5000, graceMs: 2000, maxMessages: 8 });

// The bootstrap. Takes ONE boot message, from its parent only, with a port;
// then ONE job over that port. Every phase may only move forward, and only a
// result ends the run: whatever the worker sends after it, or out of order, is
// ignored, and an endless stream of messages ends it as a flood.
export const RUNNER_FRAME_SCRIPT = `
(function () {
    'use strict';
    var host = window.parent;
    if (host === window) return;
    var LOAD_MS = ${RUNNER_LIMITS.loadMs}, RUN_MS = ${RUNNER_LIMITS.runMs}, MAX_MESSAGES = ${RUNNER_LIMITS.maxMessages};
    var taken = false;
    function take(e) {
        if (taken || e.source !== host) return;
        var d = e.data, port = e.ports && e.ports[0];
        if (!d || typeof d !== 'object' || !d.__runnerBoot || !port) return;
        var boot = d.__runnerBoot;
        if (typeof boot.worker !== 'string') return;
        taken = true;
        window.removeEventListener('message', take);
        start(boot, port);
    }
    function start(boot, port) {
        var phase = 'load', timer = 0, count = 0, ended = false, worker = null, jobSent = false;
        var url = URL.createObjectURL(new Blob([boot.worker], { type: 'text/javascript' }));
        function end(result) {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); }
            URL.revokeObjectURL(url);
            port.onmessage = null;
            try { port.postMessage({ result: result, phase: phase }); } catch (err) { port.postMessage({ result: { status: 'crash' }, phase: phase }); }
            port.close();
        }
        function arm(ms) {
            clearTimeout(timer);
            timer = setTimeout(function () { end({ status: 'timeout' }); }, ms);
        }
        function advance(next) {
            var ok = (next === 'reference' && phase === 'job')
                || (next === 'learner' && (phase === 'job' || phase === 'reference'));
            if (!ok) return;
            phase = next;
            arm(RUN_MS);
            port.postMessage({ phase: next });
        }
        // A classic worker: Chromium refuses a module worker made from a blob
        // in an opaque-origin frame.
        try {
            worker = new Worker(url);
        } catch (err) {
            end({ status: 'unavailable' });
            return;
        }
        arm(LOAD_MS);
        worker.onmessage = function (m) {
            if (++count > MAX_MESSAGES) { end({ status: 'flood' }); return; }
            var d = m.data;
            if (!d || typeof d !== 'object') return;
            if (d.result && typeof d.result === 'object') {
                if (phase === 'load' || phase === 'idle') end({ status: 'unavailable', error: typeof d.result.error === 'string' ? d.result.error.slice(0, 300) : '' });
                else end(d.result);
                return;
            }
            if (d.phase === 'ready' && phase === 'load') {
                phase = 'idle';
                clearTimeout(timer);
                port.postMessage({ phase: 'ready' });
                return;
            }
            if (typeof d.phase === 'string') advance(d.phase);
        };
        worker.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); end({ status: 'crash' }); };
        worker.onmessageerror = function () { end({ status: 'crash' }); };
        port.onmessage = function (m) {
            var d = m.data;
            if (jobSent || phase !== 'idle' || !d || typeof d !== 'object' || !d.job) return;
            jobSent = true;
            phase = 'job';
            arm(RUN_MS);
            worker.postMessage({ job: d.job });
        };
        try {
            worker.postMessage({ boot: boot.payload }, boot.transfer || []);
        } catch (err) {
            end({ status: 'unavailable' });
        }
    }
    window.addEventListener('message', take);
    window.addEventListener('load', function () {
        host.postMessage({ __runnerReady: 1 }, '*');
    });
})();
`;

/**
 * The SHA-256 of `RUNNER_FRAME_SCRIPT`, base64: the only inline script the
 * policy lets run. Written out rather than computed so this file needs no
 * import; tools/code-runner-gates.mjs fails, naming the right value, when the
 * script changes and this does not, and the frame would run nothing.
 */
export const RUNNER_FRAME_SCRIPT_HASH = 'sha256-t5VIX0gNc/1Oi9KGgEE2KOhXpeeyYZQT9d+i7eA7/wI=';

export const RUNNER_FRAME_CSP = [
    "default-src 'none'",
    `script-src '${RUNNER_FRAME_SCRIPT_HASH}' 'unsafe-eval' 'wasm-unsafe-eval' blob:`,
    'worker-src blob:',
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    'sandbox allow-scripts',
].join('; ');

export const RUNNER_FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title></title></head><body><script>${RUNNER_FRAME_SCRIPT}</script></body></html>`;

/** Express handler: the shell, under its own policy instead of the page's. */
export function sendRunnerFrame(req, res) {
    res.setHeader('Content-Security-Policy', RUNNER_FRAME_CSP);
    res.removeHeader('Content-Security-Policy-Report-Only');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(RUNNER_FRAME_HTML);
}
