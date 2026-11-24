#!/usr/bin/env node
/**
 * Runs every guard suite in one command.
 *
 * The suites are the project's test bed: each one drives real modules against a
 * scratch database or a stub, with no model, no network and no dependency on the
 * learner's own library. `npm test` runs exactly what CI runs, so the README's
 * instructions and the pull-request check can never drift apart.
 *
 * Discovery is by filename: anything matching `tools/*-gates.mjs` is a suite and
 * is picked up automatically, so adding a suite adds it to CI for free. The jsdom
 * harnesses are listed separately because they live in their own directories,
 * each bundling real `.ts` sources with esbuild before mounting them.
 *
 * Non-browser suites run in a concurrent worker pool (`--jobs N` or `GATES_JOBS`;
 * defaults to `os.availableParallelism()` on CI and `min(16, cores)` locally, with
 * child processes lowered to Idle priority locally so the machine stays responsive).
 * Browser suites run one at a time because they build and serve `dist/` and drive
 * headless Chromium; `perf-budget-gates.mjs` runs alone after the pool drains so
 * CPU contention cannot skew its CI-enforced latency budgets. Every suite's output
 * is buffered and printed whole, followed by the slowest ten suites and the totals.
 *
 * Deliberately NOT run here: the tools that need the learner's own database or a
 * live model (`feed-audit`, `feed-regen`, `quiz-audit`, `fsrs-optimize`,
 * `anki-refresh-text`, `leaf-invariant`), and the advisory linters
 * (`style-lint`, `a11y-lint`, `contrast-audit`), which report findings to a human
 * rather than passing or failing.
 *
 *   node tools/run-gates.mjs                      all suites
 *   node tools/run-gates.mjs --quick              skip the slow jsdom harnesses and the browser suites
 *   node tools/run-gates.mjs --jobs <n>           override pool concurrency (`--jobs 1` runs serially)
 *   node tools/run-gates.mjs --suites-dir <dir>   discover `*-gates.mjs` in `<dir>` (skips harnesses)
 *   node tools/run-gates.mjs --timeout-ms <n>     override the non-browser per-suite timeout in ms
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { availableParallelism, constants as osConstants, setPriority } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_PATH = resolve(fileURLToPath(import.meta.url));
const toolsDir = dirname(SELF_PATH);
const repoRoot = resolve(toolsDir, '..');

/** jsdom harnesses: mount real components and drive real events. Slow (esbuild). */
const HARNESSES = ['harness', 'anki-harness', 'vault-harness', 'dock-harness'];

/** Suites that build dist/ and open screens in a browser: minutes, not seconds. */
const BROWSER_SUITES = ['axe-gates.mjs', 'larger-ui-gates.mjs', 'perf-budget-gates.mjs', 'plan-views-gates.mjs'];
const BROWSER_SUITE_SET = new Set(BROWSER_SUITES);

/**
 * Suites that measure wall-clock latency (server cold start, first-screen draw)
 * and enforce budgets on CI. Running them after the pool drains keeps their
 * timings free of CPU contention and reuses the `dist/` built by earlier browser
 * suites.
 */
const SOLO_SUITES = new Set(['perf-budget-gates.mjs']);

/**
 * `dep-gates.mjs` walks `tools/` reading every `.mjs`/`.cjs` file, while
 * `security-gates.mjs` creates and removes temporary `.probe.mjs` files inside
 * `tools/` and the four jsdom harnesses write `bundle.cjs` inside their own
 * folders under `tools/`. Keeping `dep-gates.mjs` disjoint from those writers
 * avoids `ENOENT` and partial-read races without altering any suite.
 */
const TOOLS_READERS = new Set(['dep-gates.mjs']);
const TOOLS_WRITERS = new Set([
    'security-gates.mjs',
    ...HARNESSES.map((d) => `tools/${d}/run.mjs`),
]);

/**
 * Suites known to take tens of seconds in the non-browser pool. Starting them
 * near the front (LPT scheduling) prevents a single long suite from stalling
 * the end of a `--quick` or multi-core run.
 */
const HEAVY_FIRST = [
    'dep-gates.mjs',
    'app-update-gates.mjs',
    'ai-retry-gates.mjs',
    'code-runner-gates.mjs',
    'atlas-world-gates.mjs',
    'anki-gates.mjs',
    'anki-html-gates.mjs',
    'desktop-gates.mjs',
    'continue-offer-gates.mjs',
    'creation-timeout-gates.mjs',
    ...HARNESSES.map((d) => `tools/${d}/run.mjs`),
];
const HEAVY_RANK = new Map(HEAVY_FIRST.map((name, idx) => [name, idx]));

const DEFAULT_TIMEOUT_MS = 180_000;
const BROWSER_TIMEOUT_MS = 900_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const PIPE_DRAIN_MS = 250;
const KILL_EXIT_GRACE_MS = 2_000;

const isCI = Boolean(
    process.env.CI && process.env.CI !== '0' && process.env.CI.toLowerCase() !== 'false',
);

function parsePositiveInt(raw, flagName) {
    if (raw === undefined || !/^\d+$/.test(String(raw).trim())) {
        process.stderr.write(`Invalid value for ${flagName}: expected a positive integer, got ${JSON.stringify(raw)}\n`);
        process.exit(2);
    }
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1) {
        process.stderr.write(`Invalid value for ${flagName}: expected a positive integer, got ${JSON.stringify(raw)}\n`);
        process.exit(2);
    }
    return n;
}

function parseArgs(argv) {
    let quick = false;
    let jobsFlag;
    let suitesDir;
    let timeoutMs = DEFAULT_TIMEOUT_MS;

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--quick') {
            quick = true;
        } else if (arg === '--jobs') {
            jobsFlag = parsePositiveInt(argv[++i], '--jobs');
        } else if (arg.startsWith('--jobs=')) {
            jobsFlag = parsePositiveInt(arg.slice('--jobs='.length), '--jobs');
        } else if (arg === '--suites-dir') {
            const val = argv[++i];
            if (!val) {
                process.stderr.write('Missing path after --suites-dir\n');
                process.exit(2);
            }
            suitesDir = resolve(val);
        } else if (arg.startsWith('--suites-dir=')) {
            const val = arg.slice('--suites-dir='.length);
            if (!val) {
                process.stderr.write('Missing path after --suites-dir=\n');
                process.exit(2);
            }
            suitesDir = resolve(val);
        } else if (arg === '--timeout-ms') {
            timeoutMs = parsePositiveInt(argv[++i], '--timeout-ms');
        } else if (arg.startsWith('--timeout-ms=')) {
            timeoutMs = parsePositiveInt(arg.slice('--timeout-ms='.length), '--timeout-ms');
        } else {
            process.stderr.write(`Unknown argument: ${arg}\n`);
            process.exit(2);
        }
    }

    let jobs;
    if (jobsFlag !== undefined) {
        jobs = jobsFlag;
    } else if (process.env.GATES_JOBS !== undefined && process.env.GATES_JOBS.trim() !== '') {
        jobs = parsePositiveInt(process.env.GATES_JOBS, 'GATES_JOBS');
    } else {
        const cores = Math.max(1, availableParallelism());
        jobs = isCI ? cores : Math.min(16, cores);
    }

    return { quick, jobs, suitesDir, timeoutMs };
}

const config = parseArgs(process.argv.slice(2));
const discoveryDir = config.suitesDir ?? toolsDir;
const customDir = Boolean(config.suitesDir);

const suiteFiles = readdirSync(discoveryDir)
    .filter((f) => f.endsWith('-gates.mjs'))
    .map((f) => join(discoveryDir, f))
    // Skip this runner itself when discovering inside `tools/`, or it recurses.
    .filter((full) => resolve(full) !== SELF_PATH)
    // Browser scans are the slowest suites; --quick leaves them out with the harnesses.
    .filter((full) => !(config.quick && BROWSER_SUITE_SET.has(basename(full))))
    .sort((a, b) => basename(a).localeCompare(basename(b)));

const harnessFiles = (config.quick || customDir)
    ? []
    : HARNESSES.map((d) => join(toolsDir, d, 'run.mjs'));

const targets = [...suiteFiles, ...harnessFiles].map((script) => {
    const file = basename(script);
    const label = customDir
        ? relative(discoveryDir, script).replace(/\\/g, '/')
        : relative(repoRoot, script).replace(/\\/g, '/');
    const isBrowser = BROWSER_SUITE_SET.has(file);
    const isSolo = SOLO_SUITES.has(file);
    const isToolsReader = TOOLS_READERS.has(file);
    const isToolsWriter = TOOLS_WRITERS.has(file) || TOOLS_WRITERS.has(label);
    return {
        script,
        file,
        label,
        isBrowser,
        isSolo,
        isToolsReader,
        isToolsWriter,
        timeoutMs: isBrowser ? BROWSER_TIMEOUT_MS : config.timeoutMs,
    };
});

// Several suites call `mkdtempSync(join(repoRoot, 'node_modules', '.cache', ...))`
// without creating `.cache` first. Serial alphabetical order hid that on fresh
// checkouts because an earlier suite created it; pre-creating it removes the race.
if (!customDir && existsSync(join(repoRoot, 'node_modules'))) {
    try {
        mkdirSync(join(repoRoot, 'node_modules', '.cache'), { recursive: true });
    } catch {
        // Non-fatal: suites that need it will report their own error.
    }
}

// Per-run token inherited by children and grandchildren so Linux `/proc` cleanup
// can reap even `setsid()`-detached descendants that outlive their parent.
const RUN_ID = randomBytes(8).toString('hex');

/** Active child entries: pid -> { child, startedAt, label }. */
const activeChildren = new Map();
/** Every spawned child PID -> spawn timestamp (ms), for end-of-run orphan reaping. */
const spawnedHistory = new Map();

let stopping = false;

function killPidsWindowsSync(pids) {
    const list = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid);
    if (!list.length) return;
    const args = ['/F', '/T'];
    for (const p of list) args.push('/PID', String(p));
    try {
        spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    } catch {
        // Fall through to direct SIGKILL attempts.
    }
    for (const p of list) {
        try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ }
    }
}

function treeKillAsync(pid) {
    if (!pid || pid === process.pid) return Promise.resolve();
    if (process.platform !== 'win32') {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
        try { process.kill(pid, 'SIGKILL'); } catch { /* process already gone */ }
        return Promise.resolve();
    }
    return new Promise((done) => {
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            done();
        };
        const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
            stdio: 'ignore',
            windowsHide: true,
        });
        const guard = setTimeout(() => {
            try { killer.kill('SIGKILL'); } catch { /* ignore */ }
            try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
            finish();
        }, 10_000);
        killer.once('error', () => {
            clearTimeout(guard);
            try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
            finish();
        });
        killer.once('close', () => {
            clearTimeout(guard);
            finish();
        });
    });
}

function parseWindowsProcesses(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
}

function findWindowsDescendants(procs, rootMap) {
    const byParent = new Map();
    for (const p of procs) {
        const pid = Number(p.ProcessId);
        const ppid = Number(p.ParentProcessId);
        const ct = Number(p.Ct || 0);
        if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
        let list = byParent.get(ppid);
        if (!list) {
            list = [];
            byParent.set(ppid, list);
        }
        list.push({ pid, ct });
    }
    const found = new Set();
    const queue = [];
    for (const [rootPid, startedAt] of rootMap.entries()) {
        const kids = byParent.get(rootPid);
        if (!kids) continue;
        for (const kid of kids) {
            if (kid.pid === process.pid) continue;
            // Guard against PID reuse: only reap descendants created at or after
            // the suite started (2 s tolerance for clock granularity).
            if (kid.ct > 0 && kid.ct < startedAt - 2_000) continue;
            if (!found.has(kid.pid)) {
                found.add(kid.pid);
                queue.push(kid.pid);
            }
        }
    }
    while (queue.length) {
        const cur = queue.shift();
        const kids = byParent.get(cur);
        if (!kids) continue;
        for (const kid of kids) {
            if (kid.pid === process.pid || found.has(kid.pid)) continue;
            found.add(kid.pid);
            queue.push(kid.pid);
        }
    }
    return [...found];
}

const WIN_PROC_QUERY =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{N='Ct';E={if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{0}}} | ConvertTo-Json -Compress";

function sweepOrphansWindowsSync(rootMap) {
    if (!rootMap.size) return;
    let procs = [];
    try {
        const res = spawnSync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', WIN_PROC_QUERY],
            { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
        );
        if (res.status === 0 && res.stdout) procs = parseWindowsProcesses(res.stdout);
    } catch {
        return;
    }
    const descendants = findWindowsDescendants(procs, rootMap);
    if (descendants.length) killPidsWindowsSync(descendants);
}

function sweepOrphansWindowsAsync(rootMap) {
    if (!rootMap.size) return Promise.resolve();
    return new Promise((done) => {
        let out = '';
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            done();
        };
        const ps = spawn(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', WIN_PROC_QUERY],
            { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
        );
        const guard = setTimeout(() => {
            try { ps.kill('SIGKILL'); } catch { /* ignore */ }
            finish();
        }, 15_000);
        ps.stdout.on('data', (chunk) => {
            if (out.length < 16 * 1024 * 1024) out += chunk.toString('utf8');
        });
        ps.once('error', () => {
            clearTimeout(guard);
            finish();
        });
        ps.once('close', (code) => {
            clearTimeout(guard);
            if (code === 0 && out) {
                try {
                    const descendants = findWindowsDescendants(parseWindowsProcesses(out), rootMap);
                    if (descendants.length) killPidsWindowsSync(descendants);
                } catch {
                    // Ignore malformed output.
                }
            }
            finish();
        });
    });
}

function sweepOrphansLinuxSync() {
    if (process.platform !== 'linux') return;
    const needle = Buffer.from(`TM_GATE_RUN_ID=${RUN_ID}`);
    let entries;
    try {
        entries = readdirSync('/proc');
    } catch {
        return;
    }
    for (const name of entries) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        if (pid === process.pid) continue;
        try {
            const envBuf = readFileSync(`/proc/${name}/environ`);
            const idx = envBuf.indexOf(needle);
            if (idx === -1) continue;
            const beforeOk = idx === 0 || envBuf[idx - 1] === 0;
            const afterPos = idx + needle.length;
            const afterOk = afterPos === envBuf.length || envBuf[afterPos] === 0;
            if (beforeOk && afterOk) {
                try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
            }
        } catch {
            // Process exited or owned by another user.
        }
    }
}

function reapChildDescendantsAsync(pid, startedAt) {
    if (!pid) return Promise.resolve();
    if (process.platform !== 'win32') {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
        return Promise.resolve();
    }
    return sweepOrphansWindowsAsync(new Map([[pid, startedAt]]));
}

function shutdownOnSignal(signal, exitCode) {
    if (stopping) return;
    stopping = true;
    const activePids = [...activeChildren.keys()];
    if (process.platform === 'win32') {
        killPidsWindowsSync(activePids);
        sweepOrphansWindowsSync(spawnedHistory);
    } else {
        for (const pid of activePids) {
            try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
            try { process.kill(pid, 'SIGKILL'); } catch { /* process already gone */ }
        }
        for (const pid of spawnedHistory.keys()) {
            try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
        }
        sweepOrphansLinuxSync();
    }
    process.stderr.write(`\nInterrupted (${signal}); terminated active suites.\n`);
    process.exit(exitCode);
}

process.on('SIGINT', () => shutdownOnSignal('SIGINT', 130));
process.on('SIGTERM', () => shutdownOnSignal('SIGTERM', 143));
if (process.platform === 'win32') {
    process.on('SIGBREAK', () => shutdownOnSignal('SIGBREAK', 130));
}

function runSuite(target) {
    return new Promise((resolveSuite) => {
        const startedAt = Date.now();
        const child = spawn(process.execPath, [target.script], {
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            // On POSIX, put each suite in its own process group so a single
            // negative-PID kill reaps every descendant (esbuild, servers, browsers).
            detached: process.platform !== 'win32',
            windowsHide: true,
            env: {
                ...process.env,
                PYTHONIOENCODING: 'utf-8',
                TM_GATE_RUN_ID: RUN_ID,
            },
        });

        const pid = child.pid;
        if (pid) {
            activeChildren.set(pid, { child, startedAt, label: target.label });
            spawnedHistory.set(pid, startedAt);
            // Locally, run suites at Idle priority (PRIORITY_LOW = 19 -> Windows
            // IDLE_PRIORITY_CLASS, POSIX nice +19) so interactive work stays snappy.
            // Never throttle CI runners.
            if (!isCI) {
                try {
                    setPriority(pid, osConstants.priority.PRIORITY_LOW);
                } catch {
                    // Child may have already exited, or platform refused priority change.
                }
            }
        }

        const stdoutChunks = [];
        const stderrChunks = [];
        let capturedBytes = 0;
        let bufferExceeded = false;
        let timedOut = false;
        let spawnError = null;
        let exitCode = null;
        let exitSignal = null;
        let exited = false;
        let closed = false;
        let settled = false;
        let killDone = false;
        let pipeTimer = null;
        let killGraceTimer = null;

        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutTimer);
            clearTimeout(pipeTimer);
            clearTimeout(killGraceTimer);
            if (pid) activeChildren.delete(pid);
            const ms = Date.now() - startedAt;
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8');
            const output = `${stdout}${stderr}`;
            resolveSuite({
                target,
                ms,
                output,
                exitCode,
                exitSignal,
                timedOut,
                bufferExceeded,
                spawnError,
            });
        };

        const killAndFinish = () => {
            treeKillAsync(pid).finally(() => {
                killDone = true;
                child.stdout?.destroy();
                child.stderr?.destroy();
                if (exited) {
                    finish();
                } else {
                    killGraceTimer = setTimeout(finish, KILL_EXIT_GRACE_MS);
                }
            });
        };

        const appendChunk = (dest, chunk) => {
            if (bufferExceeded) return;
            if (capturedBytes + chunk.length > MAX_BUFFER) {
                const room = Math.max(0, MAX_BUFFER - capturedBytes);
                if (room > 0) dest.push(chunk.subarray(0, room));
                capturedBytes = MAX_BUFFER;
                bufferExceeded = true;
                clearTimeout(timeoutTimer);
                killAndFinish();
                return;
            }
            dest.push(chunk);
            capturedBytes += chunk.length;
        };

        child.stdout.on('data', (chunk) => appendChunk(stdoutChunks, chunk));
        child.stderr.on('data', (chunk) => appendChunk(stderrChunks, chunk));

        // A timeout, because a suite that hangs must fail rather than stall CI.
        const timeoutTimer = setTimeout(() => {
            if (settled) return;
            timedOut = true;
            killAndFinish();
        }, target.timeoutMs);

        child.once('error', (err) => {
            spawnError = err;
            finish();
        });

        child.once('exit', (code, signal) => {
            exited = true;
            exitCode = code;
            exitSignal = signal;
            clearTimeout(timeoutTimer);
            if (timedOut || bufferExceeded) {
                if (killDone) {
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                    finish();
                }
                return;
            }
            if (closed) {
                if (process.platform !== 'win32' && pid) {
                    try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
                }
                finish();
                return;
            }
            // If a grandchild (such as an esbuild service process) kept the
            // inherited stdout/stderr pipe open after the suite exited, drain
            // briefly, then reap the lingering subtree and close the pipes.
            pipeTimer = setTimeout(() => {
                if (settled) return;
                reapChildDescendantsAsync(pid, startedAt).finally(() => {
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                    finish();
                });
            }, PIPE_DRAIN_MS);
        });

        child.once('close', () => {
            closed = true;
            if (!exited) return;
            if (process.platform !== 'win32' && pid) {
                try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
            }
            finish();
        });
    });
}

function formatResult(res) {
    const { target, ms, output, exitCode, timedOut, bufferExceeded, spawnError } = res;

    // Every suite prints its own tally; shapes differ ("69 passed, 0 failed" vs
    // "✓ 140 deck assertions passed"), so read whichever count it offers.
    const count = output.match(/(\d+)\s+(?:passed|\w*\s?assertions)/i);
    const assertionCount = count ? Number(count[1]) : 0;

    // A suite that exits 0 while printing NO count asserted nothing, and would
    // otherwise look green after bailing out early. Bailing out is legitimate;
    // being silent about it is not. A suite that means to skip says so on a
    // `SKIPPED:` line and keeps its green; anything else with no count fails.
    const skipped = /^\s*SKIPPED:/m.test(output);
    const silent = !timedOut && !bufferExceeded && !spawnError && exitCode === 0 && !count && !skipped;
    const ok = !timedOut && !bufferExceeded && !spawnError && exitCode === 0 && !silent;

    let block = `${ok ? 'PASS' : 'FAIL'}  ${target.label.padEnd(34)} ${String(ms).padStart(6)}ms  ${count ? count[1] : (skipped ? 'skip' : '?')}\n`;
    if (timedOut) {
        block += `      timed out after ${target.timeoutMs}ms (process tree killed)\n`;
    }
    if (bufferExceeded) {
        block += `      output exceeded ${MAX_BUFFER} bytes (process tree killed)\n`;
    }
    if (spawnError) {
        block += `      spawn failed: ${spawnError.message}\n`;
    }
    if (silent) {
        block +=
            '      exited 0 without printing an assertion count. A suite that deliberately\n' +
            '      asserts nothing must print a line starting with "SKIPPED:" saying why.\n';
    }
    if (!ok) {
        block += `${output.trimEnd()}\n\n`;
    }

    return { ok, assertionCount, block, label: target.label, ms };
}

/** Order the work queue when running in parallel (`jobs > 1`). */
function buildQueue(list, jobs) {
    if (jobs === 1) return [...list];

    const browserNormal = [];
    const pool = [];
    const solo = [];
    for (const item of list) {
        if (item.isSolo) solo.push(item);
        else if (item.isBrowser) browserNormal.push(item);
        else pool.push(item);
    }

    pool.sort((a, b) => {
        const ra = HEAVY_RANK.get(a.file) ?? HEAVY_RANK.get(a.label) ?? Number.MAX_SAFE_INTEGER;
        const rb = HEAVY_RANK.get(b.file) ?? HEAVY_RANK.get(b.label) ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
        return a.label.localeCompare(b.label);
    });

    // Browser suites lead the queue so the slowest one (`axe-gates.mjs`) starts
    // at t=0 and builds `dist/` while the remaining `jobs - 1` workers drain the
    // non-browser pool. Solo suites (`perf-budget-gates.mjs`) wait at the tail.
    return [...browserNormal, ...pool, ...solo];
}

async function main() {
    const started = Date.now();
    const queue = buildQueue(targets, config.jobs);
    const running = new Set();
    const completed = [];
    let failed = 0;
    let totalAssertions = 0;

    const canStart = (item) => {
        if (running.size >= config.jobs) return false;
        if (config.jobs === 1) return running.size === 0;
        if (item.isSolo) {
            // Wait until every non-solo suite has finished (and none are running)
            // so solo suites get uncontended CPU and an up-to-date `dist/`.
            return running.size === 0 && !queue.some((q) => !q.isSolo);
        }
        for (const r of running) {
            if (r.isSolo) return false;
            if (item.isBrowser && r.isBrowser) return false;
            if (item.isToolsReader && r.isToolsWriter) return false;
            if (item.isToolsWriter && r.isToolsReader) return false;
        }
        return true;
    };

    await new Promise((resolveAll) => {
        const schedule = () => {
            if (stopping) return;
            if (queue.length === 0 && running.size === 0) {
                resolveAll();
                return;
            }
            let launched = true;
            while (launched && !stopping && running.size < config.jobs) {
                launched = false;
                for (let i = 0; i < queue.length; i += 1) {
                    const candidate = queue[i];
                    if (!canStart(candidate)) continue;
                    queue.splice(i, 1);
                    running.add(candidate);
                    launched = true;
                    runSuite(candidate).then((res) => {
                        running.delete(candidate);
                        if (stopping) return;
                        const formatted = formatResult(res);
                        if (!formatted.ok) failed += 1;
                        totalAssertions += formatted.assertionCount;
                        completed.push({ label: formatted.label, ms: formatted.ms });
                        // Emit each suite's block in a single write so concurrent
                        // completions never interleave lines.
                        process.stdout.write(formatted.block);
                        schedule();
                    });
                    break;
                }
            }
        };
        schedule();
    });

    // Final single-pass sweep for any detached grandchild that outlived a suite
    // that closed stdio cleanly.
    if (process.platform === 'win32') {
        sweepOrphansWindowsSync(spawnedHistory);
    } else {
        sweepOrphansLinuxSync();
    }

    if (completed.length > 0) {
        const slowest = [...completed]
            .sort((a, b) => b.ms - a.ms || a.label.localeCompare(b.label))
            .slice(0, 10);
        let slowestBlock = `\nSlowest ${slowest.length}:\n`;
        for (const entry of slowest) {
            slowestBlock += `  ${entry.label.padEnd(34)} ${String(entry.ms).padStart(6)}ms\n`;
        }
        process.stdout.write(slowestBlock);
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(
        `\n${targets.length - failed}/${targets.length} suites passed, ` +
            `~${totalAssertions} assertions, ${seconds}s${config.quick ? ' (--quick: harnesses and browser scans skipped)' : ''}\n`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

main();
