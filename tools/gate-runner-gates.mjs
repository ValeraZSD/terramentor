#!/usr/bin/env node
/**
 * Guard suite for the gate runner (`tools/run-gates.mjs`).
 *
 * Drives the real runner against temporary fixture directories (`--suites-dir`),
 * never against `tools/` itself, so it finishes in seconds and cannot recurse.
 * Verifies every contract the runner makes: pass/fail classification, tally
 * summation, `SKIPPED:`, silent exit-0 failure, crashes before tally, timeout
 * process-tree kills, pipe-holding and detached grandchild cleanup, whole
 * non-interleaved failure blocks, the slowest-ten section, browser and conflict
 * serialization, `--jobs 1`, `GATES_JOBS`, `--quick`, and local Idle priority.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants as osConstants, getPriority, setPriority, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolsDir, '..');
const RUNNER = join(toolsDir, 'run-gates.mjs');

let pass = 0;
let fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) {
        pass += 1;
        console.log(`  ok    ${label}`);
    } else {
        fail += 1;
        console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`);
    }
};

function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err?.code === 'EPERM';
    }
}

function readPidFile(path) {
    if (!existsSync(path)) return null;
    const n = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
}

function runRunner(args, extraEnv = {}, unsetEnv = []) {
    const env = { ...process.env, ...extraEnv };
    for (const k of unsetEnv) delete env[k];
    const r = spawnSync(process.execPath, [RUNNER, ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
        env,
    });
    return {
        status: r.status,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        output: `${r.stdout || ''}${r.stderr || ''}`,
    };
}

function intervalsOverlap(a, b) {
    return a.start < b.end && b.start < a.end;
}

const scratch = mkdtempSync(join(tmpdir(), 'gate-runner-gates-'));
const pidFilesToGuard = [];

try {
    // -------------------------------------------------------------------------
    // 1. Mixed fixture directory: pass, alternate tally, fail, hang, crash,
    //    silent exit 0, SKIPPED, and surviving-grandchild (pipe + detached).
    // -------------------------------------------------------------------------
    console.log('\n--- mixed fixture suite ---');
    {
        const dir = join(scratch, 'mixed');
        const pidHangChild = join(scratch, 'hang-grandchild.pid');
        const pidPipeGrandchild = join(scratch, 'pipe-grandchild.pid');
        const pidDetachedGrandchild = join(scratch, 'detached-grandchild.pid');
        pidFilesToGuard.push(pidHangChild, pidPipeGrandchild, pidDetachedGrandchild);

        mkdirSync(dir, { recursive: true });

        writeFileSync(
            join(dir, 'a-pass-gates.mjs'),
            `console.log('checked alpha');\nconsole.log('12 passed, 0 failed');\n`,
        );

        writeFileSync(
            join(dir, 'b-assertions-gates.mjs'),
            `setTimeout(() => {\n  console.log('✓ 8 deck assertions passed');\n}, 120);\n`,
        );

        writeFileSync(
            join(dir, 'c-fail-gates.mjs'),
            `console.log('FAIL_BLOCK_START');\n`
            + `for (let i = 0; i < 15; i++) console.log('FAIL_LINE_' + i);\n`
            + `console.log('2 passed, 1 failed');\n`
            + `console.log('FAIL_BLOCK_END');\n`
            + `process.exit(1);\n`,
        );

        writeFileSync(
            join(dir, 'd-hang-gates.mjs'),
            `import { spawn } from 'node:child_process';\n`
            + `import { writeFileSync } from 'node:fs';\n`
            + `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n`
            + `writeFileSync(${JSON.stringify(pidHangChild)}, String(child.pid));\n`
            + `console.log('hanging suite started');\n`
            + `setInterval(() => {}, 1000);\n`,
        );

        writeFileSync(
            join(dir, 'e-crash-gates.mjs'),
            `console.log('about to crash before any tally');\n`
            + `throw new Error('synthetic crash');\n`,
        );

        writeFileSync(
            join(dir, 'f-silent-gates.mjs'),
            `console.log('exited zero without a tally or skip');\n`,
        );

        writeFileSync(
            join(dir, 'g-skip-gates.mjs'),
            `console.log('SKIPPED: synthetic optional tool missing');\n`,
        );

        // Spawns BOTH a detached pipe-holding grandchild AND a detached
        // stdio-ignored grandchild, prints a passing tally, and exits 0.
        writeFileSync(
            join(dir, 'h-grandchild-gates.mjs'),
            `import { spawn } from 'node:child_process';\n`
            + `import { writeFileSync } from 'node:fs';\n`
            + `const g1 = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });\n`
            + `g1.unref();\n`
            + `writeFileSync(${JSON.stringify(pidPipeGrandchild)}, String(g1.pid));\n`
            + `const g2 = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });\n`
            + `g2.unref();\n`
            + `writeFileSync(${JSON.stringify(pidDetachedGrandchild)}, String(g2.pid));\n`
            + `console.log('3 passed, 0 failed');\n`
            + `setTimeout(() => process.exit(0), 80);\n`,
        );

        const res = runRunner(['--suites-dir', dir, '--jobs', '4', '--timeout-ms', '3000']);
        const out = res.stdout;

        check('mixed run exits 1 when any suite fails', res.status === 1, `status=${res.status}`);
        check('passing suite marked PASS with count 12', /^PASS\s+a-pass-gates\.mjs\s+\d+ms\s+12$/m.test(out));
        check('assertions-worded suite marked PASS with count 8', /^PASS\s+b-assertions-gates\.mjs\s+\d+ms\s+8$/m.test(out));
        check('failing suite marked FAIL with count 2', /^FAIL\s+c-fail-gates\.mjs\s+\d+ms\s+2$/m.test(out));
        check('hanging suite marked FAIL after timeout', /^FAIL\s+d-hang-gates\.mjs\s+\d+ms\s+\?$/m.test(out) && /timed out after 3000ms/i.test(out));
        check('crashing suite marked FAIL with ?', /^FAIL\s+e-crash-gates\.mjs\s+\d+ms\s+\?$/m.test(out) && /synthetic crash/.test(out));
        check('silent exit-0 suite marked FAIL with explanation',
            /^FAIL\s+f-silent-gates\.mjs\s+\d+ms\s+\?$/m.test(out) && /exited 0 without printing an assertion count/.test(out));
        check('SKIPPED suite marked PASS with skip', /^PASS\s+g-skip-gates\.mjs\s+\d+ms\s+skip$/m.test(out));
        check('grandchild-spawning suite exits PASS with count 3 without waiting for timeout',
            /^PASS\s+h-grandchild-gates\.mjs\s+\d+ms\s+3$/m.test(out));

        // Total assertions: 12 + 8 + 2 + 3 = 25; passed: a, b, g, h = 4/8.
        check('summary prints 4/8 suites passed and ~25 assertions',
            /^4\/8 suites passed, ~25 assertions, \d+\.\ds$/m.test(out), out.slice(-400));

        // Slowest section present, lists all 8 suites, ordered descending by time.
        const slowMatch = out.match(/Slowest 8:\r?\n((?:  .+\r?\n)+)/);
        check('slowest section is printed at the end', Boolean(slowMatch));
        if (slowMatch) {
            const times = slowMatch[1]
                .trim()
                .split(/\r?\n/)
                .map((line) => Number(line.match(/(\d+)ms$/)?.[1]));
            const sortedDesc = times.every((t, i) => i === 0 || times[i - 1] >= t);
            check('slowest section lists 8 entries in non-increasing order', times.length === 8 && sortedDesc, JSON.stringify(times));
            check('hanging suite is slowest in the mixed fixture', /d-hang-gates\.mjs/.test(slowMatch[1].trim().split(/\r?\n/)[0]));
        }

        // Whole-output block for failing suite (no other suite's header in between).
        const failStart = out.indexOf('FAIL  c-fail-gates.mjs');
        const failBodyStart = failStart >= 0 ? out.indexOf('\n', failStart) + 1 : -1;
        const failEnd = failBodyStart > 0 ? out.indexOf('FAIL_BLOCK_END', failBodyStart) : -1;
        const failSlice = failBodyStart > 0 && failEnd > failBodyStart ? out.slice(failBodyStart, failEnd) : '';
        const otherSuiteInBlock = /^(?:PASS|FAIL)  /m.test(failSlice);
        const allLinesPresent = Array.from({ length: 15 }, (_, i) => `FAIL_LINE_${i}`).every((tag) => failSlice.includes(tag));
        check('failing suite output prints whole without interleaving', failSlice.length > 0 && !otherSuiteInBlock && allLinesPresent);

        // No fixture child or grandchild process survived.
        const pHang = readPidFile(pidHangChild);
        const pPipe = readPidFile(pidPipeGrandchild);
        const pDet = readPidFile(pidDetachedGrandchild);
        check('hanging suite grandchild PID was recorded and killed', pHang !== null && !isAlive(pHang), `pid=${pHang}`);
        check('pipe-holding grandchild PID was recorded and killed', pPipe !== null && !isAlive(pPipe), `pid=${pPipe}`);
        check('detached grandchild PID was recorded and killed', pDet !== null && !isAlive(pDet), `pid=${pDet}`);
    }

    // -------------------------------------------------------------------------
    // 2. All-passing fixture dir (>10 suites): exit 0, Slowest 10 cap, priority
    // -------------------------------------------------------------------------
    console.log('\n--- all-passing + slowest-ten cap + priority ---');
    {
        const dir = join(scratch, 'passing');
        mkdirSync(dir, { recursive: true });
        for (let i = 1; i <= 12; i += 1) {
            const name = `s${String(i).padStart(2, '0')}-gates.mjs`;
            const delay = i === 12 ? 150 : 0;
            writeFileSync(
                join(dir, name),
                `setTimeout(() => { console.log('${i} passed, 0 failed'); }, ${delay});\n`,
            );
        }
        const res = runRunner(['--suites-dir', dir, '--jobs', '4']);
        check('all-passing run exits 0', res.status === 0, `status=${res.status}`);
        // Sum 1..12 = 78
        check('summary prints 12/12 suites passed and ~78 assertions',
            /^12\/12 suites passed, ~78 assertions, \d+\.\ds$/m.test(res.stdout));
        const slowMatch = res.stdout.match(/Slowest 10:\r?\n((?:  .+\r?\n)+)/);
        const slowLines = slowMatch ? slowMatch[1].trim().split(/\r?\n/) : [];
        check('slowest section caps at 10 entries when 12 suites run', slowLines.length === 10, `got ${slowLines.length}`);

        // Local Idle priority vs CI normal priority.
        const prioDir = join(scratch, 'priority');
        const prioFile = join(scratch, 'prio.json');
        mkdirSync(prioDir, { recursive: true });
        writeFileSync(
            join(prioDir, 'p-gates.mjs'),
            `import { getPriority } from 'node:os';\n`
            + `import { writeFileSync } from 'node:fs';\n`
            + `writeFileSync(${JSON.stringify(prioFile)}, JSON.stringify({ prio: getPriority() }));\n`
            + `console.log('1 passed, 0 failed');\n`,
        );

        const ownPrio = getPriority();
        try {
            if (ownPrio === osConstants.priority.PRIORITY_LOW) {
                setPriority(0, osConstants.priority.PRIORITY_NORMAL);
            }
        } catch {
            // Unprivileged POSIX processes cannot raise nice back up; compare against ownPrio below.
        }
        const basePrio = getPriority();
        try {
            const localRun = runRunner(['--suites-dir', prioDir, '--jobs', '1'], {}, ['CI', 'GATES_JOBS']);
            const localPrio = JSON.parse(readFileSync(prioFile, 'utf8')).prio;
            check('local run lowers child priority to PRIORITY_LOW (Idle)',
                localRun.status === 0 && localPrio === osConstants.priority.PRIORITY_LOW,
                `got ${localPrio}, want ${osConstants.priority.PRIORITY_LOW}`);

            const ciRun = runRunner(['--suites-dir', prioDir, '--jobs', '1'], { CI: 'true' }, ['GATES_JOBS']);
            const ciPrio = JSON.parse(readFileSync(prioFile, 'utf8')).prio;
            check('CI run preserves parent priority instead of lowering it',
                ciRun.status === 0 && ciPrio === basePrio,
                `got ${ciPrio}, want ${basePrio}`);
        } finally {
            if (getPriority() !== ownPrio) {
                try { setPriority(0, ownPrio); } catch { /* ignore */ }
            }
        }
    }

    // -------------------------------------------------------------------------
    // 3. Whole-output non-interleaving under concurrent failures
    // -------------------------------------------------------------------------
    console.log('\n--- concurrent failing suites never interleave ---');
    {
        const dir = join(scratch, 'interleave');
        mkdirSync(dir, { recursive: true });
        for (let s = 1; s <= 4; s += 1) {
            writeFileSync(
                join(dir, `f${s}-gates.mjs`),
                `const tag = 'SUITE_${s}';\n`
                + `let n = 0;\n`
                + `const iv = setInterval(() => {\n`
                + `  for (let k = 0; k < 5; k++) console.log(tag + '_LINE_' + (n++));\n`
                + `  if (n >= 30) { clearInterval(iv); console.log('0 passed, 1 failed'); process.exit(1); }\n`
                + `}, 10);\n`,
            );
        }
        const res = runRunner(['--suites-dir', dir, '--jobs', '4']);
        check('concurrent failing suites exit 1', res.status === 1);
        let intact = true;
        for (let s = 1; s <= 4; s += 1) {
            const re = new RegExp(`FAIL  f${s}-gates\\.mjs\\s+\\d+ms  0\\r?\\n((?:SUITE_${s}_LINE_\\d+\\r?\\n){30})0 passed, 1 failed`);
            if (!re.test(res.stdout)) intact = false;
        }
        check('every concurrent failing suite prints its 30 lines contiguously', intact);
    }

    // -------------------------------------------------------------------------
    // 4. Serialization rules: browser suites, tools-dir conflict, perf-budget solo,
    //    --quick skipping browser suites, --jobs 1 & GATES_JOBS=1
    // -------------------------------------------------------------------------
    console.log('\n--- scheduling constraints and flags ---');
    {
        const dir = join(scratch, 'sched');
        const logFile = join(scratch, 'sched.jsonl');
        mkdirSync(dir, { recursive: true });

        const mkTimed = (name, holdMs) => {
            writeFileSync(
                join(dir, name),
                `import { appendFileSync } from 'node:fs';\n`
                + `const start = Date.now();\n`
                + `setTimeout(() => {\n`
                + `  appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ name: ${JSON.stringify(name)}, start, end: Date.now() }) + '\\n');\n`
                + `  console.log('1 passed, 0 failed');\n`
                + `}, ${holdMs});\n`,
            );
        };

        mkTimed('axe-gates.mjs', 220);
        mkTimed('larger-ui-gates.mjs', 220);
        mkTimed('perf-budget-gates.mjs', 180);
        mkTimed('dep-gates.mjs', 180);
        mkTimed('security-gates.mjs', 180);
        mkTimed('plain-gates.mjs', 180);

        const res = runRunner(['--suites-dir', dir, '--jobs', '4']);
        check('scheduled constraint fixture exits 0', res.status === 0, res.output.slice(-400));

        const spans = Object.fromEntries(
            readFileSync(logFile, 'utf8')
                .trim()
                .split(/\r?\n/)
                .map((l) => JSON.parse(l))
                .map((e) => [e.name, e]),
        );

        check('browser suites (axe + larger-ui) never overlap',
            !intervalsOverlap(spans['axe-gates.mjs'], spans['larger-ui-gates.mjs']));
        check('dep-gates and security-gates never overlap (tools-dir mutex)',
            !intervalsOverlap(spans['dep-gates.mjs'], spans['security-gates.mjs']));
        check('perf-budget-gates runs alone after every other suite',
            Object.entries(spans)
                .filter(([k]) => k !== 'perf-budget-gates.mjs')
                .every(([, s]) => !intervalsOverlap(spans['perf-budget-gates.mjs'], s)));

        // --quick skips all three browser suites and runs the 3 non-browser ones.
        const quickRes = runRunner(['--suites-dir', dir, '--quick', '--jobs', '4']);
        check('--quick skips browser suites and reports 3/3 passed',
            quickRes.status === 0
            && /^3\/3 suites passed, ~3 assertions, \d+\.\ds \(--quick: harnesses and browser scans skipped\)$/m.test(quickRes.stdout)
            && !quickRes.stdout.includes('axe-gates.mjs')
            && !quickRes.stdout.includes('larger-ui-gates.mjs')
            && !quickRes.stdout.includes('perf-budget-gates.mjs'));

        // --jobs 1 and GATES_JOBS=1 run serially (no overlap between two non-browser suites).
        const serialDir = join(scratch, 'serial');
        const serialLog = join(scratch, 'serial.jsonl');
        mkdirSync(serialDir, { recursive: true });
        for (const name of ['x-gates.mjs', 'y-gates.mjs']) {
            writeFileSync(
                join(serialDir, name),
                `import { appendFileSync } from 'node:fs';\n`
                + `const start = Date.now();\n`
                + `setTimeout(() => {\n`
                + `  appendFileSync(${JSON.stringify(serialLog)}, JSON.stringify({ name: ${JSON.stringify(name)}, start, end: Date.now() }) + '\\n');\n`
                + `  console.log('1 passed, 0 failed');\n`
                + `}, 150);\n`,
            );
        }
        const j1 = runRunner(['--suites-dir', serialDir, '--jobs', '1']);
        const j1Spans = readFileSync(serialLog, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
        check('--jobs 1 runs suites strictly serially', j1.status === 0 && !intervalsOverlap(j1Spans[0], j1Spans[1]));

        rmSync(serialLog, { force: true });
        const envJ1 = runRunner(['--suites-dir', serialDir], { GATES_JOBS: '1' });
        const envSpans = readFileSync(serialLog, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
        check('GATES_JOBS=1 runs suites strictly serially', envJ1.status === 0 && !intervalsOverlap(envSpans[0], envSpans[1]));

        const badJobs = runRunner(['--suites-dir', serialDir, '--jobs', '0']);
        check('invalid --jobs 0 exits non-zero', badJobs.status !== 0);
    }

    // -------------------------------------------------------------------------
    // 5. SIGINT mid-run kills active suites and grandchildren on POSIX
    //    (Windows TerminateProcess via child.kill does not deliver CTRL_C_EVENT;
    //    timeout tree-kill and orphan cleanup are exercised above on Windows too.)
    // -------------------------------------------------------------------------
    if (process.platform !== 'win32') {
        console.log('\n--- SIGINT mid-run cleanup (POSIX) ---');
        const sigDir = join(scratch, 'sigint');
        const pidFile = join(scratch, 'sigint-grandchild.pid');
        pidFilesToGuard.push(pidFile);
        mkdirSync(sigDir, { recursive: true });
        writeFileSync(
            join(sigDir, 'wait-gates.mjs'),
            `import { spawn } from 'node:child_process';\n`
            + `import { writeFileSync } from 'node:fs';\n`
            + `const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n`
            + `writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));\n`
            + `setInterval(() => {}, 1000);\n`,
        );

        const runner = spawn(process.execPath, [RUNNER, '--suites-dir', sigDir, '--jobs', '2'], {
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const deadline = Date.now() + 10_000;
        while (!existsSync(pidFile) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }
        const gpid = readPidFile(pidFile);
        runner.kill('SIGINT');
        const code = await new Promise((r) => runner.once('exit', (c) => r(c)));
        await new Promise((r) => setTimeout(r, 150));
        check('SIGINT exits non-zero and leaves no surviving grandchild',
            code !== 0 && gpid !== null && !isAlive(gpid), `code=${code}, gpid=${gpid}`);
    }
} finally {
    // Safety net: kill any fixture PID that survived a failed assertion.
    for (const pf of pidFilesToGuard) {
        const pid = readPidFile(pf);
        if (pid && isAlive(pid)) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
        }
    }
    rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
