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
import { parse } from '@babel/parser';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
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
    'src/components/feed/InlineQuestion.tsx': {
        'jsx-a11y/no-autofocus': 'the box takes the caret only when the learner\'s Check opened a second try',
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
    // --no-ignore: an .eslintignore must not drop files, and with them their findings, from the count.
    const run = spawnSync(process.execPath, [OXLINT, '--no-ignore', '-c', CONFIG, '-f', 'json', ...paths], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let report;
    try {
        report = JSON.parse(run.stdout);
    } catch {
        throw new Error(`oxlint gave no report (exit ${run.status}):\n${(run.stdout + run.stderr).slice(-2000)}`);
    }
    const counts = {};
    // A diagnostic with no jsx-a11y code (a file oxlint could not parse) is never counted or allowed.
    const other = [];
    for (const d of report.diagnostics) {
        const file = String(d.filename ?? '?').replace(/\\/g, '/');
        const m = /^jsx-a11y\((.+)\)$/.exec(d.code ?? '');
        if (!m) {
            other.push(`        ${file}:${d.labels?.[0]?.span?.line ?? '?'}  ${d.code ?? 'no rule'}: ${d.message}`);
            continue;
        }
        const rule = `jsx-a11y/${m[1]}`;
        counts[file] ??= {};
        counts[file][rule] = (counts[file][rule] ?? 0) + 1;
    }
    return { counts, diagnostics: report.diagnostics, files: report.number_of_files, other };
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

// oxlint drops whatever its own bulk file lists before it reports: a second, unreviewed allowlist.
check('there is no oxlint-suppressions.json beside the sources', !existsSync(join(ROOT, 'oxlint-suppressions.json')));
// Every source file under src/, read from the disk: what oxlint must have read, and where directives are looked for.
const sources = readdirSync(join(ROOT, 'src'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(jsx?|tsx?|mjs|cjs|mts|cts)$/.test(e.name))
    .map((e) => relative(ROOT, join(e.parentPath, e.name)).replace(/\\/g, '/'));
const { counts, diagnostics, files, other } = lint(['src']);
// A file oxlint skipped (an ignore file it still obeys) would lower the allowlist on --accept for an unchanged finding.
check(`oxlint read every source file under src/ (${files} of ${sources.length})`, sources.length > 100 && files === sources.length);
check('every finding is a jsx-a11y rule (none is a file oxlint could not parse)', !other.length, other.join('\n'));

/**
 * Disable directives in `text`, as { line, rules } (rules empty = every rule).
 * The file is parsed, so only real comments are read (`// …`, `/* … *\/`, `{/* … *\/}`
 * in JSX): the same words in a string or JSX text are not a directive, and a line
 * comment ends wherever JavaScript says it does (U+2028 and U+2029 included).
 * As oxlint does, the directive must open the comment after Rust whitespace,
 * which is JavaScript's \s plus U+0085 (NEL).
 */
function directives(text, file = 'x.tsx') {
    const plugins = file.endsWith('.tsx') ? ['jsx', 'typescript'] : ['jsx'];
    const { comments } = parse(text, { sourceType: 'unambiguous', plugins, errorRecovery: true });
    const found = [];
    for (const c of comments) {
        const lead = /^(?:\s|\x85)*/u.exec(c.value)[0].length;
        const m = /^((?:eslint|oxlint)-disable(?:-next-line|-line)?)(?![\w-])/.exec(c.value.slice(lead));
        if (!m) continue;
        // A description follows "--", or a lone "-" with space around it, as oxlint reads it.
        const body = c.value.slice(lead + m[0].length).split(/--|\s-\s/)[0];
        // The line the directive itself is on: a block comment may start it on a later line than `/*`.
        const at = c.start + 2 + lead;
        found.push({ line: text.slice(0, at).split('\n').length, rules: body.match(/[\w@/-]+\/[\w-]+|[\w-]+/g) ?? [] });
    }
    return found;
}
check('a directive in a comment is read, the same words in a string are not',
    directives("const tip = 'add eslint-disable jsx-a11y/alt-text to hide it';\n").length === 0
    && JSON.stringify(directives('  {/* eslint-disable-next-line jsx-a11y/no-autofocus */}\n')) === '[{"line":1,"rules":["jsx-a11y/no-autofocus"]}]'
    && JSON.stringify(directives('x;\n{/*\n  eslint-disable-next-line jsx-a11y/alt-text\n*/}\n')) === '[{"line":3,"rules":["jsx-a11y/alt-text"]}]'
    && JSON.stringify(directives('/* eslint-disable-next-line no-debugger,\n   jsx-a11y/alt-text */\n')) === '[{"line":1,"rules":["no-debugger","jsx-a11y/alt-text"]}]'
    && JSON.stringify(directives('// oxlint-disable-line -- why\n')) === '[{"line":1,"rules":[]}]'
    && JSON.stringify(directives('// oxlint-disable-next-line - temporary\n')) === '[{"line":1,"rules":[]}]'
    && JSON.stringify(directives(`//${String.fromCharCode(0xa0)}oxlint-disable-next-line jsx-a11y/alt-text\n`)) === '[{"line":1,"rules":["jsx-a11y/alt-text"]}]'
    && directives("//\nconst t = 'oxlint-disable-next-line jsx-a11y/alt-text';\n").length === 0
    && JSON.stringify(directives(`//${String.fromCharCode(0x85)}oxlint-disable-next-line jsx-a11y/alt-text\n`)) === '[{"line":1,"rules":["jsx-a11y/alt-text"]}]'
    && directives(`const tip = "//${String.fromCharCode(0x85)}oxlint-disable-next-line jsx-a11y/alt-text";\n`).length === 0
    && directives('const url = "https://x.test//eslint-disable";\nconst P = () => <p>// eslint-disable</p>;\n').length === 0
    && directives(`//${String.fromCharCode(0x2028)}const t = 'oxlint-disable-next-line jsx-a11y/alt-text';\n`).length === 0
    && directives(`//${String.fromCharCode(0x2029)}const t = 'oxlint-disable-next-line jsx-a11y/alt-text';\n`).length === 0
    && JSON.stringify(directives(`// oxlint-disable-next-line${String.fromCharCode(0x2028)}x;\n`)) === '[{"line":1,"rules":[]}]');

/** A directive's rule as the jsx-a11y rule oxlint will switch off (it accepts `alt-text` alone), or null. */
const a11yRule = (r) => (known.includes(r) ? r : known.includes(`jsx-a11y/${r}`) ? `jsx-a11y/${r}` : null);
check('a jsx-a11y rule named without its prefix is still read as that rule',
    a11yRule('alt-text') === 'jsx-a11y/alt-text' && a11yRule('jsx-a11y/alt-text') === 'jsx-a11y/alt-text' && a11yRule('no-debugger') === null);

/** Whether a .js file holds JSX: an element (`<a `, `<my-el/>`, `<svg:g>`) where an expression starts, or a fragment `<>`.
 *  The position rule keeps a comparison such as `a<b ` from reading as a tag. */
const hasJsx = (text) => /(?:^|[=(,?:{}[;&|>]|\b(?:return|default|case|else|yield|await|throw|void|typeof))\s*<[A-Za-z][\w.:-]*[\s/>]|<\/?>/m.test(text);
check('JSX is seen in a .js file, hyphenated and fragment elements and after a keyword too; plain JS is not',
    hasJsx('export const C = () => <my-element aria-labeledby="x" />;') && hasJsx('const F = () => <>x</>;')
    && hasJsx('const D = () => <div>x</div>;') && hasJsx('export default <img src="x.png" />;')
    && hasJsx('function E() { throw <p>x</p>; }') && hasJsx('void <img src="x.png" />;') && hasJsx('typeof <p>x</p>;') && !hasJsx('for (let i = 0; i<length; i++) if (a<b || a < b) x();')
    && !hasJsx(readFileSync(join(ROOT, 'src', 'sw-template.js'), 'utf8')));

// Comments that switch a jsx-a11y rule off where they stand.
const stray = [];
for (const f of sources) {
    // oxlint parses JSX in .js, .mjs and .cjs files too; a .ts file cannot hold JSX.
    if (!/\.(jsx|tsx|js|mjs|cjs)$/.test(f)) continue;
    const text = readFileSync(join(ROOT, f), 'utf8');
    // A blanket directive matters only where there is JSX for a jsx-a11y rule to see.
    const jsx = /\.(jsx|tsx)$/.test(f) || hasJsx(text);
    let found;
    try {
        found = directives(text, f);
    } catch (err) {
        // A file the scan cannot read is never passed unread.
        stray.push(`        ${f}  could not be parsed: ${err.message}`);
        continue;
    }
    for (const { line, rules } of found) {
        if (!rules.length && jsx) stray.push(`        ${f}:${line}  every rule`);
        for (const rule of rules.map(a11yRule).filter(Boolean)) {
            if (!SUPPRESSED[f]?.[rule]) stray.push(`        ${f}:${line}  ${rule}`);
        }
    }
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
