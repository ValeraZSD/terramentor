#!/usr/bin/env node
/**
 * Accessibility rules on the JSX itself: oxlint's jsx-a11y rules over `src/`.
 *
 *   node tools/a11y-lint-gates.mjs            check `src/` against tools/a11y-lint-allowlist.json
 *   node tools/a11y-lint-gates.mjs --accept   lower the allowlist to what `src/` shows now
 *   node tools/a11y-lint-gates.mjs --accept --bootstrap   write it even where it rises (say why)
 *
 * WHY. The browser scan (axe-gates) sees only the screens it opens, in the
 * states it reaches. A click handler on a <div> inside a menu nobody opens in
 * that scan, a label tied to no field in a rarely used dialog, a video with
 * no captions track: those are visible in the source of every component, so
 * they are checked there too. No browser, no model, no network; a few seconds.
 *
 * The rules are every jsx-a11y rule oxlint has (tools/oxlint-a11y.json), less
 * two that ask for a style rather than catch a barrier:
 *   prefer-tag-over-role  wants <output> for role="status" and the like; the
 *                         ARIA role is valid and announced the same way.
 *   no-redundant-roles    flags role="list" on <ul>, which is there on
 *                         purpose: Safari drops a styled list's semantics
 *                         without it.
 * The config is checked against oxlint's own rule list, so a rule a newer
 * oxlint adds is either switched on or named here.
 *
 * Findings that were already there when the gate came in are allowed per file
 * and rule, and the allowlist only goes down, as in axe-gates: one more in a
 * file fails, and so does one fewer, so the number is lowered in the same
 * commit as the fix (`--accept`). A new file starts with none allowed. Many
 * listed findings are a rule not knowing a component (it cannot see that
 * <Checkbox role="switch"> renders a real checkbox that carries its state);
 * the list is the place to see them, not a reason to switch a rule off.
 *
 * Before anything is trusted, oxlint is run on a planted <img> with no alt and
 * a <div onClick> with no key handler, and must report both: a run that read
 * no files, or a config oxlint ignored, would otherwise read as a clean tree.
 *
 * oxlint obeys `eslint-disable … jsx-a11y/…` comments and has no switch to
 * ignore them, so a barrier with such a comment over it would pass unseen.
 * Each one in `src/` is listed in SUPPRESSED with its reason; any other fails.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'tools', 'oxlint-a11y.json');
const ALLOWLIST = join(ROOT, 'tools', 'a11y-lint-allowlist.json');
const STYLE_ONLY = ['jsx-a11y/prefer-tag-over-role', 'jsx-a11y/no-redundant-roles'];
/** Inline jsx-a11y suppressions allowed, per file and rule, with the reason. */
const SUPPRESSED = {
    'src/components/answer/FillInInput.tsx': {
        'jsx-a11y/no-autofocus': 'the answer box takes focus only when the question surface asks for it',
    },
};
const require = createRequire(import.meta.url);
const OXLINT = join(dirname(require.resolve('oxlint/package.json')), 'bin', 'oxlint');
const { acceptAllowlist } = await import(pathToFileURL(join(ROOT, 'tools', 'lib', 'axeScreens.mjs')).href);

const args = process.argv.slice(2);
const accept = args.includes('--accept');
const bootstrap = args.includes('--bootstrap');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? `\n${extra}` : ''}`); }
};

/** oxlint over `paths` (relative to `cwd`), as { file: { rule: count } } plus the raw findings. */
function lint(paths, cwd = ROOT) {
    const run = spawnSync(process.execPath, [OXLINT, '-c', CONFIG, '-f', 'json', ...paths], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let report;
    try {
        report = JSON.parse(run.stdout);
    } catch {
        throw new Error(`oxlint gave no report (exit ${run.status}):\n${(run.stdout + run.stderr).slice(-2000)}`);
    }
    const counts = {};
    for (const d of report.diagnostics) {
        const file = d.filename.replace(/\\/g, '/');
        const rule = d.code.replace(/^jsx-a11y\((.+)\)$/, 'jsx-a11y/$1');
        counts[file] ??= {};
        counts[file][rule] = (counts[file][rule] ?? 0) + 1;
    }
    return { counts, diagnostics: report.diagnostics, files: report.number_of_files };
}

// The config: every rule oxlint has, less the two above.
const schema = JSON.parse(readFileSync(join(dirname(OXLINT), '..', 'configuration_schema.json'), 'utf8'));
const known = [...new Set(JSON.stringify(schema).match(/jsx-a11y\/[a-z0-9-]+/g))].sort();
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const on = Object.entries(config.rules).filter(([, v]) => v === 'error').map(([k]) => k);
const missing = known.filter((r) => !on.includes(r) && !STYLE_ONLY.includes(r));
check(`the config switches on every jsx-a11y rule oxlint has but the ${STYLE_ONLY.length} style rules (${on.length} of ${known.length})`,
    known.length > 30 && !missing.length, missing.map((r) => `        not on: ${r}`).join('\n'));
const unknown = on.filter((r) => !known.includes(r));
check('the config names no rule oxlint does not have', !unknown.length, unknown.map((r) => `        ${r}`).join('\n'));

// A planted fault: proof the run reads files and applies the rules.
const planted = mkdtempSync(join(tmpdir(), 'a11y-lint-'));
try {
    writeFileSync(join(planted, 'Planted.tsx'), 'export const P = () => <div onClick={() => {}}><img src="x.png" /></div>;\n');
    const seen = lint(['Planted.tsx'], planted).counts['Planted.tsx'] ?? {};
    check('oxlint reports a planted <img> with no alt (the rules really run)', seen['jsx-a11y/alt-text'] === 1);
    check('oxlint reports a planted <div onClick> with no key handler', seen['jsx-a11y/click-events-have-key-events'] === 1);
} finally {
    rmSync(planted, { recursive: true, force: true });
}

const { counts, diagnostics, files } = lint(['src']);
check(`oxlint read the client sources (${files} files)`, files > 100);

// Comments that switch a jsx-a11y rule off where they stand.
const stray = [];
for (const rel of readdirSync(join(ROOT, 'src'), { recursive: true })) {
    const f = `src/${String(rel).replace(/\\/g, '/')}`;
    if (!/\.(jsx|tsx)$/.test(f)) continue; // jsx-a11y finds nothing outside JSX
    readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
        if (!/(eslint|oxlint)-disable/.test(line)) return;
        for (const rule of line.match(/jsx-a11y\/[\w-]+/g) ?? []) {
            if (!SUPPRESSED[f]?.[rule]) stray.push(`        ${f}:${i + 1}  ${rule}`);
        }
        if (/(eslint|oxlint)-disable(-next-line|-line)?\s*(\*\/|--|$)/.test(line.trim())) stray.push(`        ${f}:${i + 1}  every rule`);
    });
}
check('no jsx-a11y rule is switched off by a comment outside SUPPRESSED', !stray.length, stray.join('\n'));
console.log(`\n${diagnostics.length} finding(s) in ${Object.keys(counts).length} file(s)`);

const file = existsSync(ALLOWLIST) ? JSON.parse(readFileSync(ALLOWLIST, 'utf8')) : { allowed: {} };
const allowed = file.allowed ?? {};

if (accept) {
    // A run whose own checks failed cannot be trusted to lower the allowlist.
    if (fail) {
        console.log('\nnot writing the allowlist: a check above failed');
        process.exit(1);
    }
    // A file with no findings now is written as an empty entry, so acceptAllowlist drops it.
    const now = Object.fromEntries(Object.keys(allowed).map((f) => [f, {}]));
    Object.assign(now, counts);
    const result = acceptAllowlist(allowed, now, { bootstrap });
    if (result.refused) {
        console.log(`\nrefusing to raise the allowlist:\n  ${result.refused.join('\n  ')}\nfix these, or run with --bootstrap and say why in the commit`);
        process.exit(1);
    }
    writeFileSync(ALLOWLIST, `${JSON.stringify({ about: file.about ?? 'jsx-a11y findings allowed per file and rule. Numbers only go down: see tools/a11y-lint-gates.mjs.', allowed: result.allowed }, null, 2)}\n`);
    console.log(`wrote ${Object.values(result.allowed).reduce((a, r) => a + Object.values(r).reduce((x, y) => x + y, 0), 0)} allowed finding(s) in ${Object.keys(result.allowed).length} file(s)`);
    process.exit(0);
}

const where = (f, rule) => diagnostics
    .filter((d) => d.filename.replace(/\\/g, '/') === f && d.code === rule.replace(/^jsx-a11y\/(.+)$/, 'jsx-a11y($1)'))
    .map((d) => `          ${f}:${d.labels?.[0]?.span?.line ?? '?'}  ${d.message}${d.help ? `\n            ${d.help}` : ''}`);
const worse = [];
const better = [];
for (const f of new Set([...Object.keys(counts), ...Object.keys(allowed)])) {
    const now = counts[f] ?? {};
    const limit = allowed[f] ?? {};
    for (const [rule, n] of Object.entries(now)) if (n > (limit[rule] ?? 0)) worse.push(`        ${rule}: ${n} > ${limit[rule] ?? 0} allowed\n${where(f, rule).join('\n')}`);
    for (const [rule, n] of Object.entries(limit)) if ((now[rule] ?? 0) < n) better.push(`        ${f} ${rule}: ${now[rule] ?? 0} now, ${n} allowed`);
}
check('no finding beyond the allowlist', !worse.length, worse.join('\n'));
check('the allowlist is no higher than the sources (lower it: node tools/a11y-lint-gates.mjs --accept)', !better.length, better.join('\n'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
