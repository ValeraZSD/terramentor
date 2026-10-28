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
import { serialize } from 'node:v8';

// One reader at a time, across every kind: each may be allowed a gigabyte or
// two, and uploads arriving together must not each start one.
let queue = Promise.resolve();

/**
 * Run `modulePath` in a child process on `input` and resolve to what its
 * handler returned. Rejects with the handler's own error text, or with one of
 * `messages` when the child ran out of time (`timeout`), out of memory
 * (`outOfMemory`), had more to send back than `replyMb` (`reply`) or stopped
 * some other way (`stopped(how)`). The limit refusals, and a handler error
 * that was one, carry `tooLarge = true`, as every size refusal here does.
 *
 * The reply cap protects THIS process: the reply is copied into it and decoded
 * on its thread, so the child's heap ceiling alone does not bound it.
 *
 * @param {string} modulePath  absolute path of a module that calls `serveIsolated`
 * @param {*} input            anything the structured clone carries (Buffers, Maps)
 * @param {{ heapMb: number, timeoutMs: number, replyMb?: number,
 *           messages: { timeout: string, outOfMemory: string, reply: string,
 *                       stopped: (how: string) => string } }} limits
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

// What a child may send back unless its caller says otherwise: the size of the
// largest input any reader accepts.
const DEFAULT_REPLY_MB = 512;

// What a reader's process inherits from the server's environment: what the
// operating system and Node need to start a process and find a temp folder,
// and the locale, and nothing else. A reader is handed hostile input by
// design; the server's environment holds the provider keys, the password, the
// library's paths and NODE_OPTIONS (which would load code into the child before
// any of ours ran). None of the readers reads an environment variable, so a
// child that never had them cannot leak them, whatever its input makes it do.
// Matched case-insensitively: Windows spells PATH as `Path`.
const CHILD_ENV_KEYS = new Set([
    'PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
]);

/** The environment a reader's child process starts with (see above). */
export function isolatedChildEnv(env = process.env) {
    const out = {};
    for (const [key, value] of Object.entries(env)) {
        if (CHILD_ENV_KEYS.has(key.toUpperCase()) && typeof value === 'string') out[key] = value;
    }
    return out;
}

function runInChild(modulePath, input, { heapMb, timeoutMs, replyMb = DEFAULT_REPLY_MB, messages }) {
    return new Promise((resolve, reject) => {
        const child = fork(modulePath, [], {
            env: isolatedChildEnv(),
            execArgv: [`--max-old-space-size=${heapMb}`],
            serialization: 'advanced',
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
        let settled = false;
        let timedOut = false;
        let grace = null;
        const finish = (settle, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(grace);
            settle(value);
        };
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
            grace = setTimeout(() => finish(reject, limitError(messages.timeout)), EXIT_GRACE_MS);
            grace.unref();
        }, timeoutMs);
        child.once('message', (msg) => {
            if (msg?.replyTooLarge) return finish(reject, limitError(messages.reply));
            if (msg?.error) {
                const err = new Error(msg.error);
                if (msg.tooLarge) err.tooLarge = true;
                return finish(reject, err);
            }
            finish(resolve, msg?.result);
        });
        child.once('error', (err) => {
            child.kill('SIGKILL');
            finish(reject, err);
        });
        // `close`, not `exit`: it comes after the IPC channel has drained, so a
        // reply still in flight when the child exits is read first.
        child.once('close', (code, signal) => {
            if (timedOut) return finish(reject, limitError(messages.timeout));
            if (/heap out of memory|heap limit/i.test(stderr)) return finish(reject, limitError(messages.outOfMemory));
            if (!settled) console.error(`[isolated] ${modulePath} stopped (${signal || `code ${code}`}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
            finish(reject, new Error(messages.stopped(signal || `code ${code}`)));
        });
        child.send({ input, deadlineMs: timeoutMs + EXIT_GRACE_MS, replyBytes: replyMb * 1024 * 1024 });
    });
}

// The child's own guard, on a thread of its own so it still runs while the
// main thread is stuck in a synchronous loop (a SQLite query, a regular
// expression). It ends the process at its deadline, and as soon as the server
// that started it is gone: the server's timer died with the server, and on
// Linux and macOS a child outlives its parent (Windows ends it with the
// parent's job), so without this a reader stuck when the server stopped would
// spin on one core until the machine restarts. EPERM means the parent is there
// and merely not ours to signal.
const WATCHDOG = `
const { workerData: { parent, deadlineMs } } = require('node:worker_threads');
const end = () => process.kill(process.pid, 'SIGKILL');
setTimeout(end, deadlineMs);
setInterval(() => { try { process.kill(parent, 0); } catch (err) { if (err.code !== 'EPERM') end(); } }, 1000);
`;

/**
 * The child's half: answer the one input this process was started for with
 * `{ result }` or `{ error }`, then exit.
 *
 * @param {(input: any) => any} handler
 */
export function serveIsolated(handler) {
    process.once('message', async ({ input, deadlineMs, replyBytes }) => {
        new Worker(WATCHDOG, { eval: true, workerData: { parent: process.ppid, deadlineMs } }).unref();
        let reply;
        try {
            reply = { result: await handler(input) };
            // Measured as it will travel; past the cap, only the refusal does.
            if (serialize(reply).length > replyBytes) reply = { replyTooLarge: true };
        } catch (err) {
            reply = { error: String(err?.message || err), tooLarge: !!err?.tooLarge };
        }
        process.send(reply, () => process.exit(0));
    });
}
