// tools/lib/suiteWatchdog.mjs: loaded by tools/run-gates.mjs into every suite
// it starts (`node --import`), before the suite's own code.
//
// The runner stops its suites itself on a timeout, on Ctrl+C and on any signal
// it can catch. This covers the case it cannot: the runner killed outright (Task
// Manager, `taskkill /F`, SIGKILL, a cancelled CI job). Nothing then stops the
// suites it started: on Windows a child outlives its parent, and on Linux each
// suite runs in a process group of its own, out of reach of the terminal. So
// once a second the suite checks that the runner is still there, and when it is
// gone the suite ends itself and everything it started.
//
// It acts only in the runner's direct child: a suite that starts Node with its
// own `process.execArgv` passes this module on, and those processes are ended
// with the suite's tree instead.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const runner = Number(process.env.RUN_GATES_PID);
// The suite sees the environment it saw before the runner added this variable.
delete process.env.RUN_GATES_PID;

if (runner > 0 && process.ppid === runner) {
    const windows = process.platform === 'win32';
    const gone = () => {
        // On Linux and macOS an orphan is adopted by another process at once.
        // Windows keeps the creator's id, so ask whether the runner still runs.
        if (!windows) return process.ppid !== runner;
        try { process.kill(runner, 0); return false; } catch (err) { return err.code === 'ESRCH'; }
    };
    const timer = setInterval(() => {
        if (!gone()) return;
        clearInterval(timer);
        if (windows) {
            const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
            spawnSync(taskkill, ['/PID', String(process.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
            // The runner starts each suite as the leader of its own group.
            try { process.kill(-process.pid, 'SIGKILL'); } catch { /* not a group leader */ }
        }
        process.kill(process.pid, 'SIGKILL');
    }, 1000);
    timer.unref();
}
