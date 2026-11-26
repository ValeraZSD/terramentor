// Shared by the fixture suites of tools/gate-runner-gates.mjs. Each fixture
// notes its process ids and when it ran in the folder the gate names
// (RUN_GATES_FIXTURE_DIR), so the gate can check afterwards what ran beside
// what, and that nothing the fixtures started is still running.

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.RUN_GATES_FIXTURE_DIR;
const startedAt = Date.now();

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function note(name, value) {
    if (dir) writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

export const noted = (name) => Boolean(dir) && existsSync(join(dir, name));

/** When this fixture ran, from its first line to now. */
export const noteSpan = (name) => note(`${name}.span`, { start: startedAt, end: Date.now() });

/**
 * A Node process that outlives the fixture: it sleeps for a minute. With
 * `inherit` it holds the fixture's output pipes open after the fixture ends,
 * as esbuild's service process does; with `ignore` nothing points at it.
 * `detached` takes it out of the fixture's reach: out of its process group on
 * Linux, and out of the job object in which Node on Windows ends a child
 * together with its parent. Only there: macOS has no /proc, so the runner
 * cannot find a process that left the group, and the fixture does not ask it to.
 * A child that sleeps its whole minute notes `<name>.slept`, so the gate can
 * tell that a run waited for it without reading a clock.
 */
export function leaveBehind(name, stdio, { detached = false } = {}) {
    const apart = detached && (process.platform === 'win32' || process.platform === 'linux');
    const slept = dir ? [join(dir, `${name}.slept`)] : [];
    const code = "setTimeout(() => { if (process.argv[1]) require('fs').writeFileSync(process.argv[1], ''); }, 60000)";
    const child = spawn(process.execPath, ['-e', code, ...slept], { stdio, detached: apart, windowsHide: true });
    note(`${name}.pid`, String(child.pid));
    child.unref();
}

/** Tagged lines printed over time, so a runner that streamed output would mix two fixtures' lines. */
export async function chatter(tag, lines = 12) {
    for (let i = 0; i < lines; i++) {
        process.stdout.write(`${tag} line ${i}\n`);
        await sleep(15);
    }
}
