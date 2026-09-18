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
 * Deliberately NOT run here: the tools that need the learner's own database or a
 * live model (`feed-audit`, `feed-regen`, `quiz-audit`, `fsrs-optimize`,
 * `anki-refresh-text`, `leaf-invariant`), and the advisory linters
 * (`style-lint`, `a11y-lint`, `contrast-audit`), which report findings to a human
 * rather than passing or failing.
 *
 *   node tools/run-gates.mjs            all suites
 *   node tools/run-gates.mjs --quick    skip the slow jsdom harnesses
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(toolsDir, '..');

/** jsdom harnesses: mount real components and drive real events. Slow (esbuild). */
const HARNESSES = ['harness', 'anki-harness', 'vault-harness', 'dock-harness'];

const quick = process.argv.includes('--quick');

const self = 'run-gates.mjs'; // this file matches the glob it defines — skip it, or it recurses

const suites = readdirSync(toolsDir)
    .filter((f) => f.endsWith('-gates.mjs') && f !== self)
    .sort()
    .map((f) => join(toolsDir, f));

const harnesses = quick ? [] : HARNESSES.map((d) => join(toolsDir, d, 'run.mjs'));

const targets = [...suites, ...harnesses];

let failed = 0;
let totalAssertions = 0;
const started = Date.now();

for (const script of targets) {
    const label = relative(repoRoot, script).replace(/\\/g, '/');
    const t0 = Date.now();
    // A timeout, because a suite that hangs must fail rather than stall CI: the
    // ones that bundle `.ts` with esbuild leave a service process behind, and a
    // grandchild holding the inherited stdout pipe open blocks the parent's wait
    // long after the suite itself has finished.
    const run = spawnSync(process.execPath, [script], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 180_000,
        killSignal: 'SIGKILL',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const ms = Date.now() - t0;
    const output = `${run.stdout || ''}${run.stderr || ''}`;

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
    const silent = run.status === 0 && !count && !skipped;

    const ok = run.status === 0 && !silent;
    if (!ok) failed += 1;
    process.stdout.write(
        `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${String(ms).padStart(6)}ms  ${count ? count[1] : (skipped ? 'skip' : '?')}\n`,
    );
    if (silent) {
        process.stdout.write(
            '      exited 0 without printing an assertion count. A suite that deliberately\n' +
            '      asserts nothing must print a line starting with "SKIPPED:" saying why.\n',
        );
    }
    if (!ok) process.stdout.write(`${output.trimEnd()}\n\n`);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
process.stdout.write(
    `\n${targets.length - failed}/${targets.length} suites passed, ` +
        `~${totalAssertions} assertions, ${seconds}s${quick ? ' (--quick: harnesses skipped)' : ''}\n`,
);
process.exit(failed === 0 ? 0 : 1);
