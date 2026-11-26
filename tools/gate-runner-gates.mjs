// tools/gate-runner-gates.mjs — the suite runner on suites made to misbehave.
//
// Run:  node tools/gate-runner-gates.mjs   (about 15 s)
//
// `npm test` is only as honest as tools/run-gates.mjs under it: a runner that
// miscounts, waits forever on a hung suite, mixes two suites' output or leaves
// processes behind turns every other suite's result into noise. So the runner
// is driven here against the fixture suites in tools/fixtures/run-gates/,
// through --suites-dir (never the real suites) and a short --timeout-ms:
//
//   1. basic/, side by side and then with --jobs 1: a pass, a fail, a hang, a
//      crash before any count, a silent exit 0, a SKIPPED:, and two that end
//      while a process they started runs on (one holding the output pipes).
//      The exit code, each suite's verdict and count, the assertion total and
//      the final line, each failure's output as one block under its FAIL line,
//      the slowest-ten list, and nothing a fixture started left running.
//   2. lanes/: fixtures named like the browser suites. perf-budget-gates runs
//      first and alone, the other two never side by side, while two plain
//      fixtures that each wait for the other pass only if the pool runs them at
//      once. Locally the suites start at idle priority; on CI at the runner's
//      own. --quick leaves the browser ones out.
//   3. stop/: the runner stopped mid-run. SIGINT on Linux and macOS (and
//      SIGKILL, which only the suites' watchdog answers); on Windows, where a
//      signal sent from Node is TerminateProcess, the runner killed outright.
//      It exits non-zero and nothing it started is left.
//   4. Bad settings (--jobs 0, GATES_JOBS=abc, an unknown flag) are refused.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { constants as osConstants, getPriority, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = fileURLToPath(new URL('.', import.meta.url));
const runner = join(toolsDir, 'run-gates.mjs');
const fixtures = join(toolsDir, 'fixtures', 'run-gates');
const WINDOWS = process.platform === 'win32';
// Long enough for a cold Node start on a loaded CI runner: this gate runs inside a full pool.
const TIMEOUT_MS = 6000;
const scratchRoot = mkdtempSync(join(tmpdir(), 'gate-runner-gates-'));

let pass = 0, fail = 0;
const details = [];
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}`); if (extra) details.push(`--- ${label}\n${extra}`); }
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function killTree(pid) {
    if (WINDOWS) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(-pid, 'SIGKILL'); } catch { /* no group */ } try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/** The process ids the fixtures of one run noted. */
const notedPids = (scratch) => readdirSync(scratch).filter((f) => f.endsWith('.pid'))
    .map((f) => ({ name: f, pid: Number(readFileSync(join(scratch, f), 'utf8')) }))
    // A file read before its id was written gives 0, and kill(-0) is this process's own group.
    .filter(({ pid }) => Number.isInteger(pid) && pid > 0);

/** Wait (up to `ms`) for every noted process of a run to end; return the ones still running. */
async function survivors(scratch, ms = 8000) {
    const deadline = Date.now() + ms;
    let left = notedPids(scratch).filter((p) => alive(p.pid));
    while (left.length && Date.now() < deadline) {
        await sleep(100);
        left = left.filter((p) => alive(p.pid));
    }
    return left;
}

/** Run the runner over one fixture folder. `env` values of undefined are removed. */
function runRunner(dir, args, { env: extra = {}, whileRunning } = {}) {
    const scratch = mkdtempSync(join(scratchRoot, `${dir}-`));
    const env = { ...process.env, RUN_GATES_FIXTURE_DIR: scratch, ...extra };
    for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
    return new Promise((done) => {
        const t0 = Date.now();
        const child = spawn(process.execPath, [runner, '--suites-dir', join(fixtures, dir), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (b) => { out += b; });
        child.stderr.on('data', (b) => { out += b; });
        // This gate must not hang either, whatever the runner does.
        const guard = setTimeout(() => killTree(child.pid), 90_000);
        whileRunning?.(child, scratch);
        child.on('close', (code, signal) => { clearTimeout(guard); done({ code, signal, out, ms: Date.now() - t0, scratch }); });
    });
}

/** The runner's per-suite lines: verdict, file name, time, count. */
const rowsOf = (out) => [...out.matchAll(/^(PASS|FAIL) {2}(\S+) +(\d+)ms {2}(\S+)\r?$/gm)]
    .map((m) => ({ verdict: m[1], label: m[2], name: basename(m[2]), ms: Number(m[3]), count: m[4] }));

const lastLine = (out) => out.trimEnd().split(/\r?\n/).at(-1);

// =============================================================================================
console.log('\n1. basic/: every way a suite can end');

const BASIC = {
    'crash-gates.mjs': ['FAIL', '?'],
    'fail-gates.mjs': ['FAIL', '2'],
    'hang-gates.mjs': ['FAIL', '?'],
    'orphan-gates.mjs': ['PASS', '1'],
    'pass-gates.mjs': ['PASS', '4'],
    'silent-gates.mjs': ['FAIL', '?'],
    'skip-gates.mjs': ['PASS', 'skip'],
    'stray-gates.mjs': ['PASS', '1'],
};

async function basicRun(jobs) {
    const how = jobs === 1 ? 'one at a time' : `${jobs} at a time`;
    const run = await runRunner('basic', ['--jobs', String(jobs), '--timeout-ms', String(TIMEOUT_MS)]);
    const rows = rowsOf(run.out);
    const lines = run.out.split(/\r?\n/);

    check(`${how}: the runner exits 1 when a suite failed`, run.code === 1, `exit ${run.code}\n${run.out}`);
    check(`${how}: only the fixture folder ran`, rows.length > 0 && rows.every((r) => r.label.includes('fixtures/run-gates/basic/')), run.out);
    for (const [name, [verdict, count]] of Object.entries(BASIC)) {
        const mine = rows.filter((r) => r.name === name);
        check(`${how}: ${name} is reported once, ${verdict} with "${count}"`,
            mine.length === 1 && mine[0].verdict === verdict && mine[0].count === count, JSON.stringify(mine));
    }
    check(`${how}: the last line is the total, with the counts of the suites that printed one`,
        /^4\/8 suites passed, ~8 assertions, \d+\.\d+s$/.test(lastLine(run.out)), lastLine(run.out));

    const silentAt = lines.findIndex((l) => /^FAIL {2}\S*silent-gates\.mjs/.test(l));
    check(`${how}: a silent exit 0 is told what it must print`, silentAt >= 0 && /exited 0 without printing an assertion count/.test(lines[silentAt + 1] || ''));
    const hang = rows.find((r) => r.name === 'hang-gates.mjs');
    check(`${how}: the hung suite is stopped at its limit and says so`,
        hang && run.out.includes(`still running after ${TIMEOUT_MS / 1000}s`), JSON.stringify(hang));
    // Each process left running sleeps a minute and then notes `.slept`: a run that waited for one finds the note.
    const slept = readdirSync(run.scratch).filter((f) => f.endsWith('.slept'));
    check(`${how}: the run did not wait out the minute the processes left running sleep`, slept.length === 0, slept.join(' '));

    // Each failure's tagged lines sit together under its own FAIL line.
    let owner = null;
    const seen = {};
    let misplaced = '';
    for (const line of lines) {
        const row = /^(?:PASS|FAIL) {2}\S*\/(\S+)-gates\.mjs /.exec(line);
        if (row) { owner = row[1]; continue; }
        const tagged = /^(\w+)-gates line \d+$/.exec(line);
        if (!tagged) continue;
        seen[tagged[1]] = (seen[tagged[1]] || 0) + 1;
        if (tagged[1] !== owner) misplaced += `${line} (under ${owner})\n`;
    }
    check(`${how}: each failure's output is one whole block under its FAIL line`,
        !misplaced && seen.fail === 12 && seen.crash === 12 && seen.hang === 12, misplaced || JSON.stringify(seen));
    check(`${how}: a crash's error is in its block`, /crash-gates fell over before it counted anything/.test(run.out));

    const at = lines.findIndex((l) => /^Slowest \d+:$/.test(l));
    const slow = at < 0 ? [] : lines.slice(at + 1, at + 9).map((l) => /^ +(\d+)ms {2}\S*\/(\S+)$/.exec(l)).filter(Boolean);
    check(`${how}: the slowest list names all eight, longest first, the hung one on top`,
        lines[at] === 'Slowest 8:' && slow.length === 8 && new Set(slow.map((m) => m[2])).size === 8
            && slow.every((m, i) => i === 0 || Number(slow[i - 1][1]) >= Number(m[1])) && slow[0][2] === 'hang-gates.mjs',
        lines.slice(at, at + 9).join('\n'));
    check(`${how}: the slowest list comes before the total`, at > 0 && at < lines.findIndex((l) => /^4\/8 suites passed/.test(l)));

    const left = await survivors(run.scratch);
    check(`${how}: nothing a fixture started is still running`, left.length === 0, JSON.stringify(left));
    check(`${how}: every fixture that starts a process noted it`, notedPids(run.scratch).length === 6, JSON.stringify(notedPids(run.scratch)));
    return { run, rows };
}

const side = await basicRun(4);
check('4 at a time: the header says how the suites run', /^Running 8 suites, 4 at a time, browser suites one at a time/.test(side.run.out));
const serial = await basicRun(1);
check('one at a time: the header says so', /^Running 8 suites, one at a time/.test(serial.run.out));
check('one at a time: the suites run in name order, as the serial runner always did',
    JSON.stringify(serial.rows.map((r) => r.name)) === JSON.stringify(Object.keys(BASIC)), serial.rows.map((r) => r.name).join(' '));

// =============================================================================================
console.log('\n2. lanes/: the browser suites, the suite that runs alone, and the pool');

const spans = (scratch) => Object.fromEntries(readdirSync(scratch).filter((f) => f.endsWith('.span'))
    .map((f) => [f.replace(/\.span$/, ''), JSON.parse(readFileSync(join(scratch, f), 'utf8'))]));
const apart = (a, b) => a.end <= b.start || b.end <= a.start;

{
    const run = await runRunner('lanes', ['--jobs', '4'], { env: { CI: undefined } });
    const rows = rowsOf(run.out);
    const s = spans(run.scratch);
    check('every lane fixture passes, and the two that wait for each other did meet',
        run.code === 0 && rows.length === 6 && rows.every((r) => r.verdict === 'PASS'), run.out);
    check('the last line is the total', /^6\/6 suites passed, ~6 assertions, \d+\.\d+s$/.test(lastLine(run.out)), lastLine(run.out));
    const others = Object.entries(s).filter(([k]) => k !== 'perf-budget');
    check('perf-budget-gates ran first and alone', s['perf-budget'] && others.length === 5
        && others.every(([, o]) => s['perf-budget'].end <= o.start), JSON.stringify(s));
    check('dep-gates ran once, alone, after perf-budget and before the pool',
        s.dep && rows.filter((r) => r.name === 'dep-gates.mjs').length === 1
        && Object.entries(s).filter(([k]) => k !== 'dep' && k !== 'perf-budget').every(([, o]) => s.dep.end <= o.start),
        JSON.stringify(s));
    check('the two browser suites never ran side by side', s.axe && s['plan-views'] && apart(s.axe, s['plan-views']), JSON.stringify(s));
    // Inside a local `npm test` this gate already runs at idle priority and its
    // fixtures would inherit it: the check proves something only from above it.
    if (getPriority() === osConstants.priority.PRIORITY_LOW) console.log('  note  idle priority not checked: this gate already runs at it');
    else check('locally the suites start at idle priority',
        readFileSync(join(run.scratch, 'pair-a.priority'), 'utf8') === String(osConstants.priority.PRIORITY_LOW),
        readFileSync(join(run.scratch, 'pair-a.priority'), 'utf8'));
}
{
    const run = await runRunner('lanes', ['--quick', '--jobs', '2'], { env: { CI: 'true' } });
    const rows = rowsOf(run.out);
    check('--quick leaves the browser suites out and runs the rest',
        run.code === 0 && JSON.stringify(rows.map((r) => r.name).sort()) === JSON.stringify(['dep-gates.mjs', 'pair-a-gates.mjs', 'pair-b-gates.mjs']), run.out);
    check('--quick says so on the last line', /\(--quick: harnesses and browser scans skipped\)$/.test(lastLine(run.out)), lastLine(run.out));
    check('on CI the suites start at the priority the runner has',
        readFileSync(join(run.scratch, 'pair-a.priority'), 'utf8') === String(getPriority()),
        `${readFileSync(join(run.scratch, 'pair-a.priority'), 'utf8')} vs ${getPriority()}`);
}

// =============================================================================================
console.log('\n3. stop/: the runner stopped mid-run');

async function stopRun(signal) {
    let ready = false;
    const run = await runRunner('stop', ['--jobs', '2', '--timeout-ms', '60000'], {
        whileRunning: async (child, scratch) => {
            const deadline = Date.now() + 20_000;
            const marks = ['wait-a.ready', 'wait-b.ready', 'wait-a-child.pid', 'wait-b-child.pid'];
            while (Date.now() < deadline && !marks.every((m) => existsSync(join(scratch, m)))) await sleep(50);
            ready = marks.every((m) => existsSync(join(scratch, m)));
            process.kill(child.pid, signal);
        },
    });
    const how = WINDOWS ? 'killed outright' : signal;
    check(`${how}: both fixtures were running when the runner was stopped`, ready, run.out);
    check(`${how}: the runner exits non-zero`, run.code !== 0 || run.signal !== null, `exit ${run.code} ${run.signal}`);
    if (!WINDOWS && signal === 'SIGINT') {
        check('SIGINT: the runner says it was stopped, and exits 130', run.code === 130 && /Stopped by SIGINT/.test(run.out), run.out);
    }
    const left = await survivors(run.scratch);
    check(`${how}: no fixture and no process a fixture started is left`, left.length === 0 && notedPids(run.scratch).length === 4, JSON.stringify(left));
}

await stopRun('SIGINT');
// Only the suites' watchdog can answer SIGKILL; on Windows the SIGINT run was this already.
if (!WINDOWS) await stopRun('SIGKILL');

// =============================================================================================
console.log('\n4. settings the runner refuses');

for (const [label, args, env] of [
    ['--jobs 0', ['--jobs', '0'], {}],
    ['GATES_JOBS=abc', [], { GATES_JOBS: 'abc' }],
    ['an unknown flag', ['--qiuck'], {}],
]) {
    const r = spawnSync(process.execPath, [runner, '--suites-dir', join(fixtures, 'lanes'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    check(`${label} is refused with exit 2 before anything runs`, r.status === 2 && !/^(PASS|FAIL)/m.test(r.stdout), `${r.status}\n${r.stdout}${r.stderr}`);
}

// Whatever a failed check left behind goes too.
for (const dir of readdirSync(scratchRoot)) {
    for (const p of notedPids(join(scratchRoot, dir))) if (alive(p.pid)) killTree(p.pid);
}
try { rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${pass} passed, ${fail} failed`);
if (details.length) console.log(`\n${details.join('\n\n')}`);
process.exit(fail ? 1 : 0);
