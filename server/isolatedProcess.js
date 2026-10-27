// server/isolatedProcess.js — run a parser of untrusted input in a child process
// of its own, with a memory ceiling and a wall-clock limit.
//
// Some inputs cannot be bounded by counting their bytes. A docx of one-letter
// runs builds a tree a hundred times its XML; an Anki collection is a SQLite
// file, and SQLite runs whatever the file's own schema says when it is queried,
// on the thread that asked. Either one, read on the server's thread, can hold
// every SSE stream, review session and generation run hostage, or end them all
// with an out-of-memory abort. So the read happens HERE instead: a forked Node
// process with its own heap ceiling and a timer, which is killed when either
// runs out, and the server only ever sees a result or a refusal.
//
// A process, not a worker thread: a worker's heap limit let V8 abort the whole
// server on some inputs ("Reached heap limit") before the worker's own
// out-of-memory handling could step in.
//
// The child is a module that calls `serveIsolated(handler)`. It receives one
// input, replies once, and exits; it is never reused, so nothing a hostile
// input did to it can reach the next one.

import { fork } from 'node:child_process';
import { Worker } from 'node:worker_threads';

// One reader at a time, across every kind: each may be allowed a gigabyte or
// two, and uploads arriving together must not each start one.
let queue = Promise.resolve();

/**
 * Run `modulePath` in a child process on `input` and resolve to what its
 * handler returned. Rejects with the handler's own error text, or with one of
 * `messages` when the child ran out of time (`timeout`), out of memory
 * (`outOfMemory`) or stopped some other way (`stopped(how)`). The two limit
 * refusals carry `tooLarge = true`, as every size refusal here does.
 *
 * @param {string} modulePath  absolute path of a module that calls `serveIsolated`
 * @param {*} input            anything the structured clone carries (Buffers, Maps)
 * @param {{ heapMb: number, timeoutMs: number,
 *           messages: { timeout: string, outOfMemory: string, stopped: (how: string) => string } }} limits
 */
export function runIsolated(modulePath, input, limits) {
    const run = queue.then(() => runInChild(modulePath, input, limits));
    queue = run.catch(() => {});
    return run;
}

function limitError(message) {
    const err = new Error(message);
    err.tooLarge = true;
    return err;
}

// Once the timer has fired, the child is killed and the refusal waits for its
// exit, so a caller that removes the child's input file afterwards does not
// race a handle still open on Windows. The grace period only matters if the
// kill itself does not land.
const EXIT_GRACE_MS = 5_000;

function runInChild(modulePath, input, { heapMb, timeoutMs, messages }) {
    return new Promise((resolve, reject) => {
        const child = fork(modulePath, [], {
            execArgv: [`--max-old-space-size=${heapMb}`],
            serialization: 'advanced',
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
        let settled = false;
        let timedOut = false;
        const finish = (settle, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            settle(value);
        };
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
            setTimeout(() => finish(reject, limitError(messages.timeout)), EXIT_GRACE_MS).unref();
        }, timeoutMs);
        child.once('message', (msg) => {
            if (msg?.error) finish(reject, new Error(msg.error));
            else finish(resolve, msg?.result);
        });
        child.once('error', (err) => finish(reject, err));
        child.once('exit', (code, signal) => {
            if (timedOut) return finish(reject, limitError(messages.timeout));
            finish(reject, /heap out of memory|heap limit/i.test(stderr)
                ? limitError(messages.outOfMemory)
                : new Error(messages.stopped(signal || `code ${code}`)));
        });
        child.send({ input, deadlineMs: timeoutMs + EXIT_GRACE_MS });
    });
}

// The child's own guard, on a thread of its own so it still runs while the
// main thread is stuck in a synchronous loop (a SQLite query, a regular
// expression). It ends the process at its deadline, and as soon as the server
// that started it is gone: the server's timer died with the server, and on
// Linux and macOS a child outlives its parent (Windows ends it with the
// parent's job), so without this a reader stuck when the server stopped would
// spin on one core until the machine restarts (measured on Linux: still
// running 10 s after its parent was killed; with this, gone within a second).
const WATCHDOG = `
const { workerData: { parent, deadlineMs } } = require('node:worker_threads');
const end = () => process.kill(process.pid, 'SIGKILL');
setTimeout(end, deadlineMs);
setInterval(() => { try { process.kill(parent, 0); } catch { end(); } }, 1000);
`;

/**
 * The child's half: answer the one input this process was started for with
 * `{ result }` or `{ error }`, then exit.
 *
 * @param {(input: any) => any} handler
 */
export function serveIsolated(handler) {
    process.once('message', async ({ input, deadlineMs }) => {
        new Worker(WATCHDOG, { eval: true, workerData: { parent: process.ppid, deadlineMs } }).unref();
        let reply;
        try {
            reply = { result: await handler(input) };
        } catch (err) {
            reply = { error: String(err?.message || err) };
        }
        process.send(reply, () => process.exit(0));
    });
}
