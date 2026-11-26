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
 * Side by side. Each suite is its own Node process with its own scratch library,
 * scratch folders (mkdtemp) and loopback ports (port 0), so the suites run in a
 * pool, `--jobs` at a time: by default every core on CI, and up to 16 elsewhere,
 * where they also run at idle CPU priority so the machine stays usable. Three kinds
 * of suite are kept apart from the pool:
 *   - the browser suites run one at a time beside it. Each builds dist/ when a
 *     source is newer, and two builds into one dist/ would break each other;
 *   - `perf-budget-gates.mjs` runs first, alone. It times the server's start and
 *     the first screens, and CI holds those times to budgets measured on an
 *     otherwise idle machine. It also builds dist/ when it is stale, so no suite
 *     after it starts a server over a half-written one;
 *   - `dep-gates.mjs` and `provenance-gates.mjs` run next, alone too: one reads
 *     every file under tools/ while other suites write there, the other counts
 *     requests in a window a loaded machine fills (ALONE_SUITES says more).
 * The slowest suites start first, by the times this checkout's last run measured
 * (node_modules/.cache/run-gates-times.json); without them, the harnesses first,
 * then the largest files. `--jobs 1` is the serial run, in name order.
 *
 * Output. A suite's output is printed whole when it ends, never mixed with
 * another's: its PASS or FAIL line with its time and assertion count, then, for
 * a failure, everything it printed. The run ends with the ten slowest suites,
 * the failures by name, and the total.
 *
 * Stopping. A suite past its time limit is killed with everything it started (a
 * process group on Linux and macOS, `taskkill /T` on Windows), and so is
 * anything a suite leaves running after it ends: the suites that bundle with
 * esbuild leave its service process behind, holding the output pipe open. Ctrl+C
 * stops every running suite the same way and exits non-zero. If the runner itself
 * is killed outright, each suite notices within a second and stops itself
 * (tools/lib/suiteWatchdog.mjs).
 *
 * Deliberately NOT run here: the tools that need the learner's own database or a
 * live model (`feed-audit`, `feed-regen`, `quiz-audit`, `fsrs-optimize`,
 * `anki-refresh-text`, `leaf-invariant`), and the advisory linters
 * (`style-lint`, `a11y-lint`, `contrast-audit`), which report findings to a human
 * rather than passing or failing.
 *
 *   node tools/run-gates.mjs                  all suites
 *   node tools/run-gates.mjs --quick          skip the slow jsdom harnesses and the browser suites
 *   node tools/run-gates.mjs --jobs 4         four suites at a time (or GATES_JOBS=4); --jobs 1 runs them one by one
 *   node tools/run-gates.mjs --suites-dir D   the *-gates.mjs files in D instead of tools/ (no harnesses)
 *   node tools/run-gates.mjs --timeout-ms N   the time limit of a suite that is not a browser suite (default 180000)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, constants as osConstants, setPriority } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(toolsDir, '..');
const WINDOWS = process.platform === 'win32';

/** jsdom harnesses: mount real components and drive real events. Slow (esbuild). */
const HARNESSES = ['harness', 'anki-harness', 'vault-harness', 'dock-harness'];

/** Suites that build dist/ and open screens in a browser: minutes, not seconds. */
const BROWSER_SUITES = ['assistant-scroll-gates.mjs', 'axe-gates.mjs', 'larger-ui-gates.mjs', 'page-scroll-gates.mjs', 'perf-budget-gates.mjs', 'plan-views-gates.mjs'];

/**
 * Suites nothing else may run beside, one by one before the pool:
 *   - perf-budget times the machine;
 *   - dep-gates walks tools/ and reads every file it lists, while security-gates
 *     creates and deletes probe files there and the harnesses write their bundles;
 *   - provenance-gates counts every request its page makes while a fake fetch is
 *     in place, waiting a fixed number of event-loop turns; on a loaded machine
 *     other requests from the same page land in that window (2 of 8 side-by-side
 *     CI jobs failed on it). It passes alone, as it always did in a serial run.
 */
const ALONE_SUITES = ['perf-budget-gates.mjs', 'dep-gates.mjs', 'provenance-gates.mjs'];

const BROWSER_TIMEOUT_MS = 900_000;
const TIMEOUT_MS = 180_000;
/** A failing axe run prints every element it names. Per stream, as spawnSync's maxBuffer was. */
const MAX_BUFFER = 64 * 1024 * 1024;
const LOCAL_JOBS_CAP = 16;
/** How long a suite's output may stay open after the suite has ended. */
const GRACE_MS = 2000;

const self = 'run-gates.mjs'; // this file matches the glob it defines — skip it, or it recurses
const TIMES_FILE = join(repoRoot, 'node_modules', '.cache', 'run-gates-times.json');
const WATCHDOG = pathToFileURL(join(toolsDir, 'lib', 'suiteWatchdog.mjs')).href;
const TASKKILL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');

const USAGE = 'usage: node tools/run-gates.mjs [--quick] [--jobs N] [--suites-dir DIR] [--timeout-ms N]';

function usageError(message) {
    process.stderr.write(`run-gates: ${message}\n${USAGE}\n`);
    process.exit(2);
}

function positiveInt(value, name) {
    const text = String(value).trim();
    if (!/^\d+$/.test(text) || Number(text) < 1) usageError(`${name} takes a whole number of 1 or more, not "${value}"`);
    return Number(text);
}

function parseArgs(argv) {
    const opts = { quick: false, jobs: null, suitesDir: null, timeoutMs: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
        const name = eq > 0 ? arg.slice(0, eq) : arg;
        const value = () => {
            if (eq > 0) return arg.slice(eq + 1);
            if (i + 1 >= argv.length) usageError(`${name} needs a value`);
            return argv[++i];
        };
        if (name === '--quick') opts.quick = true;
        else if (name === '--jobs' || name === '-j') opts.jobs = positiveInt(value(), name);
        else if (name === '--suites-dir') opts.suitesDir = resolve(value());
        else if (name === '--timeout-ms') opts.timeoutMs = positiveInt(value(), name);
        else if (name === '--help' || name === '-h') { process.stdout.write(`${USAGE}\n`); process.exit(0); }
        else usageError(`unknown argument "${arg}"`);
    }
    return opts;
}

const opts = parseArgs(process.argv.slice(2));
const quick = opts.quick;

// GitHub Actions sets CI=true; unset, empty, "false" or "0" is a local run.
const ON_CI = Boolean(process.env.CI) && !/^(false|0)$/i.test(process.env.CI);
const cores = availableParallelism();
const envJobs = process.env.GATES_JOBS?.trim() ? positiveInt(process.env.GATES_JOBS, 'GATES_JOBS') : null;
const jobs = opts.jobs ?? envJobs ?? (ON_CI ? cores : Math.min(LOCAL_JOBS_CAP, cores));
// On a contributor's machine the suites yield to whatever else it is doing.
const IDLE = !ON_CI;

// ---------------------------------------------------------------------------
// What runs
// ---------------------------------------------------------------------------

const suitesDir = opts.suitesDir ?? toolsDir;
let entries;
try { entries = readdirSync(suitesDir); } catch (err) { usageError(`cannot read ${suitesDir}: ${err.message}`); }

const suites = entries
    .filter((f) => f.endsWith('-gates.mjs') && f !== self)
    // The browser scans are the slowest suites; --quick leaves them out with the harnesses.
    .filter((f) => !(quick && BROWSER_SUITES.includes(f)))
    .sort()
    .map((f) => join(suitesDir, f));

const harnesses = quick || opts.suitesDir ? [] : HARNESSES.map((d) => join(toolsDir, d, 'run.mjs'));

const labelOf = (script) => {
    const rel = relative(repoRoot, script);
    return (rel.startsWith('..') || isAbsolute(rel) ? script : rel).replace(/\\/g, '/');
};

const targets = [...suites, ...harnesses].map((script) => {
    const name = basename(script);
    const harness = harnesses.includes(script);
    const browser = !harness && BROWSER_SUITES.includes(name);
    return {
        script, label: labelOf(script), harness, browser,
        alone: !harness && ALONE_SUITES.includes(name),
        timeoutMs: browser ? BROWSER_TIMEOUT_MS : (opts.timeoutMs ?? TIMEOUT_MS),
    };
});

// ---------------------------------------------------------------------------
// Running one suite
// ---------------------------------------------------------------------------

// RUN_GATES_PID is for tools/lib/suiteWatchdog.mjs, which removes it from the
// suite's environment. RUN_GATES_TAG stays, and passes to everything the suite
// starts: on Linux it is how a process that left the suite's group is found.
const RUN_ID = `${process.pid}.${Date.now().toString(36)}`;
const baseEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', RUN_GATES_PID: String(process.pid) };
let suiteNumber = 0;

/** Every suite started, for the sweeps: { pid, tag, start, end }. */
const started = [];
/** The suites running now. */
const running = new Set();
let stopping = null;

function groupKill(pid) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is gone */ }
}

/** Kill a running suite and everything it started. */
function killTree(proc, { reapOrphans = true } = {}) {
    if (WINDOWS) spawnSync(TASKKILL, ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else groupKill(proc.pid);
    // `/T` follows parent ids down from a live process, and a group holds only
    // what stayed in it: a branch whose middle process has already ended, or a
    // process that left the group, is reached only by a sweep.
    if (reapOrphans) reap([proc]);
}

function runSuite(t) {
    return new Promise((done) => {
        const r = { target: t, status: null, ms: 0, stdout: '', stderr: '', timedOut: false, overflow: false, error: null, leftovers: [] };
        const out = [];
        const err = [];
        const bytes = { out: 0, err: 0 };
        const t0 = Date.now();
        const tag = `${RUN_ID}/${++suiteNumber}`;
        let child;
        try {
            child = spawn(process.execPath, [`--import=${WATCHDOG}`, t.script], {
                cwd: repoRoot,
                env: { ...baseEnv, RUN_GATES_TAG: tag },
                stdio: ['ignore', 'pipe', 'pipe'],
                // Its own process group on Linux and macOS, so a timeout or Ctrl+C
                // takes everything it started. On Windows `detached` would open a
                // console window per suite; taskkill /T does the same job there.
                detached: !WINDOWS,
            });
        } catch (e) {
            r.error = e;
            r.ms = Date.now() - t0;
            done(r);
            return;
        }
        const proc = { pid: child.pid, tag, start: t0, end: null };
        if (child.pid) {
            started.push(proc);
            running.add(proc);
            // Lowered before the suite has run a line, so all it starts inherits it.
            // PRIORITY_LOW (19) is the lowest Node has: IDLE_PRIORITY_CLASS on Windows.
            if (IDLE) try { setPriority(child.pid, osConstants.priority.PRIORITY_LOW); } catch { /* left at normal */ }
        }

        let exited = false;
        let finished = false;
        let grace = null;
        const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            clearTimeout(grace);
            running.delete(proc);
            if (!proc.end) proc.end = Date.now();
            r.ms = proc.end - t0;
            r.stdout = Buffer.concat(out).toString('utf8');
            r.stderr = Buffer.concat(err).toString('utf8');
            done(r);
        };

        // A suite that hangs must fail rather than stall the run.
        const timer = setTimeout(() => { r.timedOut = true; killTree(proc); }, t.timeoutMs);
        const collect = (chunks, which) => (buf) => {
            if (r.overflow) return; // past the limit: what follows is never printed
            chunks.push(buf);
            bytes[which] += buf.length;
            if (bytes[which] > MAX_BUFFER && !r.overflow) {
                r.overflow = true;
                // After its exit the id may already be another process's: only the sweep, which checks start times.
                if (exited) reap([proc]); else killTree(proc);
            }
        };
        child.stdout.on('data', collect(out, 'out'));
        child.stderr.on('data', collect(err, 'err'));

        child.on('error', (e) => {
            r.error ??= e;
            if (!child.pid) finish(); // never started, so no exit will come
        });
        child.on('exit', (code) => {
            exited = true;
            proc.end = Date.now();
            // It ended in time: the limit no longer applies, and its id is free for reuse.
            clearTimeout(timer);
            // A suite that was killed has no status, as spawnSync reported it.
            r.status = r.timedOut || r.overflow ? null : code;
            // Ctrl+C in a Windows console reaches the suites too: they end with
            // STATUS_CONTROL_C_EXIT, which is the run being stopped, not a failure.
            if (WINDOWS && code === 0xC000013A && !stopping) { stop('SIGINT'); return; }
            // Whatever it left running in its group goes with it.
            if (!WINDOWS) groupKill(proc.pid);
            // The output is complete once every process holding the pipes has
            // let go. Something the suite started may hold them past its end.
            grace = setTimeout(() => {
                r.leftovers = reap([proc]);
                grace = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, 500);
            }, GRACE_MS);
        });
        child.on('close', () => { if (exited) finish(); });
    });
}

// ---------------------------------------------------------------------------
// Orphans on Windows: a process outlives its parent there, and only its parent's
// id says where it came from.
// ---------------------------------------------------------------------------

/** WMI's "20261124094003.123456+060" (local time, offset in minutes) as epoch ms. */
function wmiTime(text) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})\d*([+-])(\d+)$/.exec(text);
    if (!m) return NaN;
    const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
    return local - (m[8] === '+' ? 1 : -1) * Number(m[9]) * 60_000;
}

/** Every process on the machine: { pid, ppid, created, name }, or null when none can be listed. */
function listProcesses() {
    const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    const rows = [];
    // wmic answers in a fifth of PowerShell's time, but newer Windows ships without it.
    const w = run('wmic', ['process', 'get', 'CreationDate,Name,ParentProcessId,ProcessId', '/format:csv']);
    if (w.status === 0 && w.stdout) {
        for (const line of w.stdout.split(/\r*\n/)) {
            const f = line.trim().split(',');
            if (f.length < 5 || f[0] === 'Node') continue; // Node,CreationDate,Name,ParentProcessId,ProcessId
            rows.push({ pid: Number(f.at(-1)), ppid: Number(f.at(-2)), created: wmiTime(f[1]), name: f.slice(2, -2).join(',') });
        }
    }
    if (!rows.length) {
        const ps = "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0},{1},{2},{3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o'), $_.Name } }";
        const p = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
        if (p.status !== 0 || !p.stdout) return null;
        for (const line of p.stdout.split(/\r?\n/)) {
            const f = line.trim().split(',');
            if (f.length < 4) continue;
            rows.push({ pid: Number(f[0]), ppid: Number(f[1]), created: Date.parse(f[2]), name: f.slice(3).join(',') });
        }
    }
    return rows.filter((p) => p.pid > 0 && Number.isFinite(p.created));
}

/**
 * Linux: the processes whose environment carries the given RUN_GATES_TAG
 * entry, found through /proc. A process the suite started in a session of its
 * own (`detached`) has left the suite's group and been adopted by init, but it
 * still carries the environment it was started with.
 */
function tagged(entry) {
    const needle = Buffer.from(entry);
    const found = [];
    let pids = [];
    try { pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return found; }
    for (const d of pids) {
        if (Number(d) === process.pid) continue;
        let environ;
        try { environ = readFileSync(`/proc/${d}/environ`); } catch { continue; } // gone, or not ours to read
        if (!environ.includes(needle)) continue;
        let name = '?';
        try { name = readFileSync(`/proc/${d}/comm`, 'utf8').trim(); } catch { /* gone */ }
        found.push({ pid: Number(d), name });
    }
    return found;
}

/**
 * Kill what the given suites started and left running, and return it.
 *
 * Windows: by parent id. A child counts only if it was created while its suite
 * ran: Windows reuses ids, and a process that got a finished suite's id is not
 * ours. Linux: by the tag in the environment. macOS has no /proc: there only
 * the suite's process group is killed.
 */
function reap(roots) {
    if (!WINDOWS) {
        if (process.platform !== 'linux') return [];
        // One suite's processes, or (the sweep at the end, or a stop) the whole run's.
        const found = tagged(roots === started ? `RUN_GATES_TAG=${RUN_ID}/` : `RUN_GATES_TAG=${roots[0].tag}\0`);
        for (const p of found) try { process.kill(p.pid, 'SIGKILL'); } catch { /* already gone */ }
        return found;
    }
    const list = listProcesses();
    if (!list) return [];
    const SLACK = 1000;
    const now = Date.now();
    const kids = new Map();
    for (const p of list) {
        if (!kids.has(p.ppid)) kids.set(p.ppid, []);
        kids.get(p.ppid).push(p);
    }
    const byPid = new Map(list.map((p) => [p.pid, p]));
    const found = new Map();
    const walk = (p) => {
        if (found.has(p.pid) || p.pid === process.pid || p.pid === process.ppid) return;
        found.set(p.pid, p);
        for (const k of kids.get(p.pid) || []) if (k.created >= p.created - SLACK) walk(k);
    };
    // A suite's end is read with Date.now() at its 'exit', after the process
    // exited, so its children were all created before it; the margin covers only
    // the rounding of the two clocks (a Windows tick is ~15.6 ms), not a second
    // in which an id can be reused.
    const AT_END = 50;
    for (const r of roots) {
        const end = r.end ?? now;
        // The id may already belong to a newer process (one created after the suite
        // ended, or long after it started). Its children all came after it, so only
        // children created before it can be the suite's: both times come from WMI.
        const owner = byPid.get(r.pid);
        const newer = owner && owner.created > Math.min(r.start + SLACK, end) ? owner.created : Infinity;
        for (const k of kids.get(r.pid) || []) {
            if (k.created >= r.start - SLACK && k.created <= end + AT_END && k.created < newer) walk(k);
        }
    }
    const pids = [...found.keys()];
    if (pids.length) spawnSync(TASKKILL, ['/F', '/T', ...pids.flatMap((pid) => ['/PID', String(pid)])], { stdio: 'ignore', windowsHide: true });
    return [...found.values()];
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = [];
const failedLabels = [];
let totalAssertions = 0;
const t0 = Date.now();

const write = (text) => { process.stdout.write(text); };
process.stdout.on('error', () => { /* a reader that went away (npm test | head) */ });

function report(r) {
    const { label, timeoutMs } = r.target;
    const output = `${r.stdout}${r.stderr}`;

    // Every suite prints its own tally; shapes differ ("69 passed, 0 failed" vs
    // "✓ 140 deck assertions passed"), so read whichever count it offers.
    const count = output.match(/(\d+)\s+(?:passed|\w*\s?assertions)/i);
    if (count) totalAssertions += Number(count[1]);

    // A suite that exits 0 while printing NO count asserted nothing, and used to
    // show a green `?` here — which is how six suites could bail out early on a
    // missing sqlite-vec, a shallow clone or an absent esbuild and still read as
    // a pass. Bailing out is legitimate; being silent about it is not. A suite
    // that means to skip says so on a `SKIPPED:` line and keeps its green;
    // anything else that produces no count is a failure, because the only other
    // way to get here is a suite that died before its first assertion.
    const skipped = /^\s*SKIPPED:/m.test(output);
    const silent = r.status === 0 && !count && !skipped;

    // Too much output fails, as spawnSync's maxBuffer did, even when what printed it outlived the suite.
    const ok = r.status === 0 && !silent && !r.overflow;
    if (!ok) failedLabels.push(label);
    results.push({ label, ms: r.ms, ok });

    // One write per suite: its lines never mix with another suite's.
    let text = `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${String(r.ms).padStart(6)}ms  ${count ? count[1] : (skipped ? 'skip' : '?')}\n`;
    if (silent) {
        text += '      exited 0 without printing an assertion count. A suite that deliberately\n' +
            '      asserts nothing must print a line starting with "SKIPPED:" saying why.\n';
    }
    if (r.timedOut) text += `      still running after ${timeoutMs / 1000}s: stopped, with everything it started.\n`;
    if (r.overflow) text += `      printed more than ${MAX_BUFFER / 1024 / 1024} MB: stopped.\n`;
    if (r.error) text += `      could not be run: ${r.error.message}\n`;
    if (r.leftovers.length) {
        const names = [...new Set(r.leftovers.map((p) => p.name))].join(', ');
        text += `      left ${r.leftovers.length} process(es) running after it ended (${names}): stopped.\n`;
    }
    if (!ok) text += `${output.trimEnd()}\n\n`;
    write(text);
}

function slowest() {
    const top = [...results].sort((a, b) => b.ms - a.ms).slice(0, 10);
    if (!top.length) return '';
    return `\nSlowest ${top.length}:\n${top.map((s) => `  ${String(s.ms).padStart(7)}ms  ${s.label}\n`).join('')}`;
}

function failures() {
    if (!failedLabels.length) return '';
    return `\nFailed (${failedLabels.length}):\n${failedLabels.map((l) => `  ${l}\n`).join('')}`;
}

function finalLine(extra = '') {
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    const passed = results.filter((r) => r.ok).length;
    return `\n${passed}/${targets.length} suites passed, ` +
        `~${totalAssertions} assertions, ${seconds}s${quick ? ' (--quick: harnesses and browser scans skipped)' : ''}${extra}\n`;
}

/** Print, then exit once the text has reached the pipe (Windows pipe writes are asynchronous). */
function exitWith(code, text) {
    setTimeout(() => process.exit(code), 5000);
    process.stdout.write(text, () => process.exit(code));
}

// ---------------------------------------------------------------------------
// Ctrl+C and friends: stop every suite, then leave.
// ---------------------------------------------------------------------------

const exitCodeOf = (signal) => 128 + (osConstants.signals[signal] ?? 2);

function stop(signal) {
    if (stopping) return;
    stopping = signal;
    const code = exitCodeOf(signal);
    const live = [...running];
    // A suite that already ended may have handed its id on: the sweep below, which checks start times, covers it.
    for (const proc of live) if (!proc.end) killTree(proc, { reapOrphans: false });
    const leftovers = reap(started);
    const notRun = targets.length - results.length - live.length;
    let text = `\nStopped by ${signal}: ${live.length} running suite(s) killed with everything they started` +
        `${leftovers.length ? ` (${leftovers.length} process(es))` : ''}, ${notRun} not started.\n`;
    text += slowest() + failures() + finalLine(` (stopped by ${signal})`);
    exitWith(code, text);
}

// One Ctrl+C in a Windows console reaches the runner and every suite, and the
// suites' exits may get here first; only the runner's own signals are counted.
let signals = 0;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', ...(WINDOWS ? ['SIGBREAK'] : [])]) {
    process.on(signal, () => {
        signals += 1;
        if (signals > 1) process.exit(exitCodeOf(signal)); // a second Ctrl+C waits for nothing
        stop(signal);
    });
}

// ---------------------------------------------------------------------------
// The order, and the pool
// ---------------------------------------------------------------------------

/** The last measured time of each suite, longest first; size stands in for a suite never timed. */
function longestFirst(list) {
    let times = {};
    if (!opts.suitesDir) try { times = JSON.parse(readFileSync(TIMES_FILE, 'utf8')); } catch { /* first run here */ }
    const estimate = (t) => {
        if (Number.isFinite(times[t.label])) return times[t.label];
        // A harness bundles a screen and mounts it in jsdom: always among the slowest.
        if (t.harness) return 60_000;
        try { return statSync(t.script).size / 4; } catch { return 0; }
    };
    return [...list].map((t) => [estimate(t), t]).sort((a, b) => b[0] - a[0]).map(([, t]) => t);
}

function saveTimes() {
    if (opts.suitesDir) return;
    let times = {};
    try { times = JSON.parse(readFileSync(TIMES_FILE, 'utf8')); } catch { /* none yet */ }
    for (const r of results) times[r.label] = r.ms;
    for (const label of Object.keys(times)) if (!existsSync(join(repoRoot, label))) delete times[label];
    try {
        mkdirSync(dirname(TIMES_FILE), { recursive: true });
        writeFileSync(TIMES_FILE, `${JSON.stringify(times, null, 1)}\n`);
    } catch { /* the order is only an optimisation */ }
}

function runPool(browserQueue, poolQueue) {
    return new Promise((allDone) => {
        let active = 0;
        let browserBusy = false;
        const next = () => {
            if (stopping) return;
            while (active < jobs) {
                let t;
                if (!browserBusy && browserQueue.length) { t = browserQueue.shift(); browserBusy = true; }
                else if (poolQueue.length) t = poolQueue.shift();
                else break;
                active += 1;
                runSuite(t).then((r) => {
                    active -= 1;
                    if (t.browser) browserBusy = false;
                    if (stopping) return;
                    report(r);
                    next();
                });
            }
            if (active === 0 && !browserQueue.length && !poolQueue.length) allDone();
        };
        next();
    });
}

// Several suites make their scratch folder inside node_modules/.cache without
// creating .cache first. In name order a suite that creates it always ran
// earlier; side by side, on a fresh checkout, one of them may start first.
try { mkdirSync(join(repoRoot, 'node_modules', '.cache'), { recursive: true }); } catch { /* the suite reports it */ }

write(`Running ${targets.length} suites, ${jobs === 1 ? 'one at a time' : `${jobs} at a time, browser suites one at a time`}` +
    `${IDLE ? ', at idle priority' : ''}\n`);

if (jobs === 1) {
    for (const t of targets) {
        const r = await runSuite(t);
        if (stopping) break;
        report(r);
    }
} else {
    const aloneOrder = (t) => ALONE_SUITES.indexOf(basename(t.script));
    for (const t of targets.filter((x) => x.alone).sort((a, b) => aloneOrder(a) - aloneOrder(b))) {
        const r = await runSuite(t);
        if (stopping) break;
        report(r);
    }
    if (!stopping) {
        await runPool(
            targets.filter((t) => t.browser && !t.alone),
            longestFirst(targets.filter((t) => !t.browser && !t.alone)),
        );
    }
}

if (!stopping) {
    // Anything a suite left running that held no pipe, so nothing noticed it.
    const leftovers = reap(started);
    let tail = '';
    if (leftovers.length) {
        tail += `\nStopped ${leftovers.length} process(es) the suites left running: ${[...new Set(leftovers.map((p) => p.name))].join(', ')}\n`;
    }
    saveTimes();
    exitWith(failedLabels.length === 0 ? 0 : 1, tail + slowest() + failures() + finalLine());
}
