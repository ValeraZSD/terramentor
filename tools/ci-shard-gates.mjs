// tools/ci-shard-gates.mjs — CI's shards run every suite, each exactly once.
//
// Run:  node tools/ci-shard-gates.mjs   (a few seconds)
//
// .github/workflows/gates.yml splits `npm test` over several runners per
// platform (tools/run-gates.mjs --shard), and a job per platform passes only
// when all of that platform's shards passed. A split like that fails quietly:
// a suite in no shard, or a shard missing from one platform, leaves every
// check green while the suite never runs. So:
//
//   1. The suites, by this file's own reading of tools/ (not the runner's
//      list): every `*-gates.mjs` but the runner itself, and every `*harness`
//      folder with a run.mjs. Each is listed by exactly one shard, the union is
//      what a plain `npm test` runs, and the axe shard is axe-gates alone.
//   2. --shard runs what it lists: on the runner's own fixtures, a shard runs
//      its suites and nothing else; an unknown shard and a shard with no suite
//      in it are refused rather than passing by running nothing.
//   3. gates.yml: on each platform every shard has a runner and runs the suites
//      with --shard; each step around the suites (types, parse, link, build,
//      the README pictures, the zip budget) runs on exactly one shard; the two
//      checks a merge needs are named `Node 24 on <platform>`, wait for that
//      platform's shards even when one failed, and pass only on success; a newer
//      push cancels a pull request's run, never a run on main.
//   4. gates-rerun.yml re-runs failed jobs once, from the first attempt only,
//      with a token that can do that and nothing else, checking out nothing.
//   5. The other pull-request workflows cancel only pull-request runs.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(toolsDir, '..');
const runner = join(toolsDir, 'run-gates.mjs');
const workflows = join(repoRoot, '.github', 'workflows');

let pass = 0, fail = 0;
const details = [];
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}`); if (extra) details.push(`--- ${label}\n${extra}`); }
};

/** The shard names CI uses; this gate's own copy, so a renamed shard fails here. */
const SHARDS = ['axe', 'browser', 'rest'];

function runRunner(args, env = {}) {
    const r = spawnSync(process.execPath, [runner, ...args], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, lines: (r.stdout || '').split(/\r?\n/).filter(Boolean) };
}

// =============================================================================================
console.log('\n1. every suite in exactly one shard');

const ownSuites = [
    ...readdirSync(toolsDir).filter((f) => f.endsWith('-gates.mjs') && f !== 'run-gates.mjs').map((f) => `tools/${f}`),
    ...readdirSync(toolsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.endsWith('harness') && existsSync(join(toolsDir, d.name, 'run.mjs')))
        .map((d) => `tools/${d.name}/run.mjs`),
].sort();
check('this file finds the suites itself: axe-gates, this gate and at least one harness among them',
    ownSuites.includes('tools/axe-gates.mjs') && ownSuites.includes('tools/ci-shard-gates.mjs') && ownSuites.some((s) => s.endsWith('harness/run.mjs')),
    ownSuites.join('\n'));

const byShard = {};
for (const shard of SHARDS) {
    const r = runRunner(['--shard', shard, '--list']);
    byShard[shard] = r.lines;
    check(`--shard ${shard} --list names at least one suite and exits 0`, r.status === 0 && r.lines.length > 0, `${r.status}\n${r.out}`);
}
const seen = new Map();
for (const [shard, items] of Object.entries(byShard)) for (const s of items) seen.set(s, [...(seen.get(s) || []), shard]);
const missing = ownSuites.filter((s) => !seen.has(s));
const doubled = [...seen].filter(([, shards]) => shards.length > 1).map(([s, shards]) => `${s}: ${shards.join(', ')}`);
const unknown = [...seen.keys()].filter((s) => !ownSuites.includes(s));
check('no suite is left out of every shard', missing.length === 0, missing.join('\n'));
check('no suite is in two shards', doubled.length === 0, doubled.join('\n'));
check('the shards list nothing that is not a suite', unknown.length === 0, unknown.join('\n'));
check('the axe shard is axe-gates alone', JSON.stringify(byShard.axe) === JSON.stringify(['tools/axe-gates.mjs']), byShard.axe.join('\n'));
const whole = runRunner(['--list']);
check('a plain run lists exactly the suites the shards share out',
    whole.status === 0 && JSON.stringify([...whole.lines].sort()) === JSON.stringify(ownSuites), `${whole.status}\n${whole.out}`);
check('two shards together list both', runRunner(['--shard', 'axe,browser', '--list']).lines.length === byShard.axe.length + byShard.browser.length);

// =============================================================================================
console.log('\n2. --shard runs what it lists');

const scratch = mkdtempSync(join(tmpdir(), 'ci-shard-gates-'));
const lanes = join(toolsDir, 'fixtures', 'run-gates', 'lanes');
const ran = (out) => [...out.matchAll(/^(PASS|FAIL) {2}(\S+) /gm)].map((m) => m[2].replace(/^.*[\\/]/, '')).sort();
const axeRun = runRunner(['--suites-dir', lanes, '--shard', 'axe'], { RUN_GATES_FIXTURE_DIR: scratch });
check('--shard axe runs the axe suite and nothing else', axeRun.status === 0 && JSON.stringify(ran(axeRun.out)) === '["axe-gates.mjs"]', axeRun.out);
const browserRun = runRunner(['--suites-dir', lanes, '--shard', 'browser'], { RUN_GATES_FIXTURE_DIR: scratch });
check('--shard browser runs the other browser suites and nothing else',
    browserRun.status === 0 && JSON.stringify(ran(browserRun.out)) === '["perf-budget-gates.mjs","plan-views-gates.mjs"]', browserRun.out);
const bad = runRunner(['--shard', 'axes', '--list']);
check('an unknown shard is refused with exit 2', bad.status === 2, bad.out);
const empty = runRunner(['--suites-dir', join(toolsDir, 'fixtures', 'run-gates', 'basic'), '--shard', 'axe']);
check('a shard with no suite in it fails instead of passing on nothing', empty.status === 1 && !/^PASS/m.test(empty.out), `${empty.status}\n${empty.out}`);
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }

// =============================================================================================
console.log('\n3. gates.yml');

// LF whatever the checkout: a Windows clone has CRLF.
const readYml = (name) => readFileSync(join(workflows, name), 'utf8').replace(/\r\n/g, '\n');
const gates = readYml('gates.yml');
const jobsText = gates.slice(gates.indexOf('\njobs:\n'));
/** Each job's block, by id. */
const jobs = Object.fromEntries(jobsText.split(/\n(?= {2}[a-z][a-z0-9-]*:\n)/).slice(1).map((b) => [/^ {2}([a-z0-9-]+):/.exec(b)[1], b]));
/** The steps of a job, each { name, if, text }. */
const stepsOf = (job) => (job.split(/\n {6}- /).slice(1)).map((text) => ({
    name: (/(?:^|\n {8})name: (.+)/.exec(text) || [])[1]?.trim() || '',
    if: (/\n {8}if: (.+)/.exec(text) || [])[1]?.trim() || '',
    text,
}));
/** Which of the given shards a step's `if:` lets it run on. Only the forms this file uses are understood. */
function shardsRunning(cond, shards) {
    if (!cond) return shards;
    const rest = cond.replace(/^always\(\) && /, '');
    const m = /^matrix\.shard (==|!=) '([^']+)'$/.exec(rest);
    if (!m) return null; // a condition this gate cannot read
    return shards.filter((s) => (m[1] === '==' ? s === m[2] : s !== m[2]));
}

const PLATFORMS = [
    { job: 'linux', os: 'ubuntu-latest', once: ['Linux package within its size budget'] },
    { job: 'windows', os: 'windows-latest', once: ['README pictures match the app'] },
];
const ONCE = ['Types', 'Server parses', 'Server links', 'Frontend builds', 'Performance numbers'];

for (const p of PLATFORMS) {
    const job = jobs[p.job] || '';
    check(`a ${p.job} job runs on ${p.os}`, new RegExp(`\\n {4}runs-on: ${p.os}\\n`).test(job), job);
    const matrixShards = ((/\n {8}shard: \[([^\]]*)\]/.exec(job) || [])[1] || '').split(/,\s*(?=')/).map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean);
    const pieces = matrixShards.flatMap((v) => v.split(','));
    check(`${p.job}: every shard has a runner, once (${matrixShards.join(' | ')})`,
        JSON.stringify([...pieces].sort()) === JSON.stringify([...SHARDS].sort()), pieces.join(', '));
    check(`${p.job}: a failing shard does not cancel the others`, /\n {6}fail-fast: false\n/.test(job));
    check(`${p.job}: the matrix keeps the Node floor`, /\n {8}node: \['24'\]\n/.test(job));
    const steps = stepsOf(job);
    const guard = steps.filter((s) => s.name === 'Guard suites');
    check(`${p.job}: the suites run with --shard on every shard`,
        guard.length === 1 && !guard[0].if && /run: npm test -- --shard "\$\{\{ matrix\.shard \}\}"/.test(guard[0].text), guard.map((s) => s.text).join('\n'));
    for (const name of [...ONCE, ...p.once]) {
        const found = steps.filter((s) => s.name === name);
        const on = found.length === 1 ? shardsRunning(found[0].if, matrixShards) : null;
        check(`${p.job}: "${name}" runs on exactly one shard`, on?.length === 1, found.map((s) => `if: ${s.if}`).join('\n') || 'no such step');
    }
}

for (const p of PLATFORMS) {
    const name = `Node 24 on ${p.os}`;
    const carriers = Object.entries(jobs).filter(([, b]) => new RegExp(`\\n {4}name: ${name}\\n`).test(b));
    const agg = carriers[0]?.[1] || '';
    check(`exactly one job is the check "${name}"`, carriers.length === 1, carriers.map(([id]) => id).join(', '));
    check(`"${name}" waits for the ${p.job} shards, even when one failed`, new RegExp(`\\n {4}needs: ${p.job}\\n`).test(agg) && /\n {4}if: always\(\)\n/.test(agg), agg);
    check(`"${name}" passes only when every ${p.job} shard succeeded`,
        new RegExp(`RESULT: \\$\\{\\{ needs\\.${p.job}\\.result \\}\\}`).test(agg) && /\n\s+test "\$RESULT" = success\n/.test(agg), agg);
}
check('no other job carries a check name a merge needs', !Object.entries(jobs).some(([id, b]) => !id.endsWith('-result') && /\n {4}name: Node /.test(b)));

const concurrency = (/\nconcurrency:\n((?: {2}.*\n)+)/.exec(gates) || [])[1] || '';
check('a newer push cancels a pull request\'s run', /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/.test(concurrency), concurrency);
check('…and a run on main is in a group of its own, never cancelled', /group: .*github\.event_name == 'pull_request' && .*pull_request\.number.* \|\| .*github\.run_id/.test(concurrency), concurrency);

// =============================================================================================
console.log('\n4. gates-rerun.yml');

const rerun = readYml('gates-rerun.yml');
const workflowName = (/^name: (.+)$/m.exec(gates) || [])[1];
check('it follows the Gates workflow by its name', new RegExp(`\\n {4}workflows: \\[${workflowName}\\]\\n {4}types: \\[completed\\]\\n`).test(rerun) && /\n {2}workflow_run:\n/.test(rerun), rerun);
check('its token can re-run jobs and nothing else', /\npermissions:\n {2}actions: write\n\n/.test(rerun) && (rerun.match(/permissions:/g) || []).length === 1);
check('it checks out and runs nothing from the run it looks at', !/\buses:/.test(rerun) && !/npm |node /.test(rerun.replace(/^#.*$/gm, '')));
check('only a first attempt that failed is re-run', /\n {4}if: github\.event\.workflow_run\.conclusion == 'failure' && github\.event\.workflow_run\.run_attempt == 1\n/.test(rerun));
check('it re-runs the failed jobs only', /gh run rerun "\$RUN_ID" --failed\n/.test(rerun));
const script = rerun.slice(rerun.indexOf('        run: |'));
check('event values reach the script through the environment, never pasted into it', script.length > 20 && !script.includes('${{'), script);
check('a pull request\'s older run is not re-run once a newer one exists', /if \[ "\$newest" != "\$RUN_ID" \]/.test(script));
check('the job summary names the failed jobs', /select\(\.conclusion == "failure"\) \| \.name/.test(script) && /GITHUB_STEP_SUMMARY/.test(script));

// =============================================================================================
console.log('\n5. the other pull-request workflows');

for (const name of ['dco.yml', 'no-ai-attribution.yml', 'screen-reader.yml']) {
    const text = readYml(name);
    const block = (/\nconcurrency:\n((?: {2}.*\n)+)/.exec(text) || [])[1] || '';
    check(`${name}: cancels only a pull request's older run`,
        /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/.test(block) && /github\.run_id/.test(block), block || 'no concurrency block');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (details.length) console.log(`\n${details.join('\n\n')}`);
process.exitCode = fail ? 1 : 0;
