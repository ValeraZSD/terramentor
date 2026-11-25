#!/usr/bin/env node
/**
 * The locale merge driver (`tools/locale-merge.mjs`), through real `git merge`s.
 *
 * Each case builds a scratch repository holding the driver, the locale writer
 * and a `.gitattributes` naming the driver, makes two branches from one base
 * file, merges them, and compares the file with a result written out here by
 * hand. Nothing here reads the driver's own rules to decide what to expect.
 *
 *   node tools/locale-merge-gates.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRIVER_COMMAND, mergeLocales, registerLocaleMergeDriver } from './locale-merge.mjs';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'locale-merge-'));

// The scratch repositories must not take the machine's git settings (a
// conflict style, autocrlf, hooks, signing): an empty global config, no system one.
const emptyConfig = join(scratch, 'empty.gitconfig');
writeFileSync(emptyConfig, '');
const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    // The driver command runs `node`; the one running this suite.
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`,
};

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
    if (ok) passed++; else failed++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `\n        ${String(detail).replace(/\n/g, '\n        ')}`}`);
}
const eq = (name, got, want) => check(name, got === want, `got:\n${got}\nwant:\n${want}`);

function git(cwd, ...args) {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const must = (cwd, ...args) => {
    const r = git(cwd, ...args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.out}`);
    return r;
};

let n = 0;
/**
 * A repository with `src/locales/x.json` = `base` on main, branch `one` and
 * branch `two` each committing their own text, `one` checked out.
 * `withDriver` false leaves the driver unregistered.
 */
function repo(base, one, two, { withDriver = true, dropDriverOnOne = false } = {}) {
    const dir = join(scratch, `r${++n}`);
    mkdirSync(join(dir, 'tools', 'lib'), { recursive: true });
    mkdirSync(join(dir, 'src', 'locales'), { recursive: true });
    copyFileSync(join(toolsDir, 'locale-merge.mjs'), join(dir, 'tools', 'locale-merge.mjs'));
    copyFileSync(join(toolsDir, 'lib', 'localeJson.mjs'), join(dir, 'tools', 'lib', 'localeJson.mjs'));
    writeFileSync(join(dir, '.gitattributes'), '* text=auto\nsrc/locales/*.json merge=locale-json\n');
    must(dir, 'init', '-q', '-b', 'main');
    must(dir, 'config', 'user.name', 'gate');
    must(dir, 'config', 'user.email', 'gate@example.invalid');
    must(dir, 'config', 'commit.gpgsign', 'false');
    if (withDriver) registerLocaleMergeDriver(dir);
    const file = join(dir, 'src', 'locales', 'x.json');
    const commit = (text, msg) => { writeFileSync(file, text); must(dir, 'add', '-A'); must(dir, 'commit', '-q', '-m', msg); };
    commit(base, 'base');
    must(dir, 'checkout', '-q', '-b', 'two');
    commit(two, 'two');
    must(dir, 'checkout', '-q', 'main');
    must(dir, 'checkout', '-q', '-b', 'one');
    if (dropDriverOnOne) { rmSync(join(dir, 'tools'), { recursive: true }); must(dir, 'add', '-A'); }
    commit(one, 'one');
    return { dir, file };
}
const read = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const conflicted = (dir) => git(dir, 'diff', '--name-only', '--diff-filter=U').out.trim();

const BASE = '{\n  "Apple": "a",\n  "Cherry": "c"\n}\n';

try {
    // ── the three-way rule, on objects ────────────────────────────────────────
    console.log('mergeLocales');
    {
        const r = mergeLocales({ A: '1', B: '2', C: '3' }, { A: '1x', B: '2', C: '3', D: '4' }, { A: '1', C: '3', E: '5' });
        check('an edit, a delete of another key and an add on each side: all kept, the untouched key too',
            JSON.stringify(r) === JSON.stringify({ merged: { A: '1x', C: '3', D: '4', E: '5' }, conflicts: [] }), JSON.stringify(r));
        const c = mergeLocales({ A: '1', B: '2' }, { A: 'x' }, { A: 'y', B: '2b' });
        check('two edits of one key, and a delete against an edit, are conflicts',
            JSON.stringify(c) === JSON.stringify({ merged: {}, conflicts: [{ key: 'A', ours: 'x', theirs: 'y' }, { key: 'B', theirs: '2b' }] }), JSON.stringify(c));
        const s = mergeLocales({}, { A: 'same' }, { A: 'same' });
        check('the same value added on both sides is no conflict', s.conflicts.length === 0 && s.merged.A === 'same');
        const p = mergeLocales({}, JSON.parse('{"__proto__": "p"}'), {});
        check('a key named "__proto__" stays a key', Object.keys(p.merged).join() === '__proto__' && p.merged.__proto__ === 'p');
    }

    // ── real merges ───────────────────────────────────────────────────────────
    console.log('\ngit merge with the driver');
    {
        // Banana and Blueberry both sort between Apple and Cherry: a line merge
        // sees two different insertions at one spot.
        const one = '{\n  "Apple": "a",\n  "Banana": "b",\n  "Cherry": "c"\n}\n';
        const two = '{\n  "Apple": "a",\n  "Blueberry": "bb",\n  "Cherry": "c"\n}\n';

        const control = repo(BASE, one, two, { withDriver: false });
        const cm = git(control.dir, 'merge', '-q', '--no-edit', 'two');
        check('control: without the driver registered, git conflicts on two keys added side by side',
            cm.status !== 0 && conflicted(control.dir) === 'src/locales/x.json', cm.out);

        const { dir, file } = repo(BASE, one, two);
        const m = git(dir, 'merge', '-q', '--no-edit', 'two');
        check('with it, the same merge is clean', m.status === 0 && conflicted(dir) === '', m.out);
        eq('…keeps both keys, in sorted order', read(file), '{\n  "Apple": "a",\n  "Banana": "b",\n  "Blueberry": "bb",\n  "Cherry": "c"\n}\n');
    }
    {
        // One side edits a key, the other adds one next to it and deletes another.
        const base = '{\n  "Apple": "a",\n  "Cherry": "c",\n  "Date": "d"\n}\n';
        const one = '{\n  "Apple": "a (edited)",\n  "Cherry": "c",\n  "Date": "d"\n}\n';
        const two = '{\n  "Apple": "a",\n  "Apricot": "ap",\n  "Cherry": "c"\n}\n';
        const { dir, file } = repo(base, one, two);
        const m = git(dir, 'merge', '-q', '--no-edit', 'two');
        check('an edit beside an add and a delete merges clean', m.status === 0, m.out);
        eq('…with all three changes', read(file), '{\n  "Apple": "a (edited)",\n  "Apricot": "ap",\n  "Cherry": "c"\n}\n');
    }
    {
        const one = '{\n  "Apple": "a1",\n  "Cherry": "c"\n}\n';
        const two = '{\n  "Apple": "a2",\n  "Cherry": "c"\n}\n';
        const { dir, file } = repo(BASE, one, two);
        const m = git(dir, 'merge', '--no-edit', 'two');
        check('one key given two values is a conflict', m.status !== 0 && conflicted(dir) === 'src/locales/x.json', m.out);
        check('…and the driver names the key', /changed on both sides/.test(m.out) && /"Apple"/.test(m.out), m.out);
        eq('…with markers around that key\'s line only',
            read(file), '{\n<<<<<<< ours\n  "Apple": "a1",\n=======\n  "Apple": "a2",\n>>>>>>> theirs\n  "Cherry": "c"\n}\n');
    }
    {
        const one = '{\n  "Apple": "a"\n}\n';
        const two = '{\n  "Apple": "a",\n  "Cherry": "c (edited)"\n}\n';
        const { dir, file } = repo(BASE, one, two);
        const m = git(dir, 'merge', '--no-edit', 'two');
        check('a key deleted on one side and edited on the other is a conflict', m.status !== 0 && conflicted(dir) === 'src/locales/x.json', m.out);
        eq('…the deleting side shows empty',
            read(file), '{\n  "Apple": "a",\n<<<<<<< ours\n=======\n  "Cherry": "c (edited)"\n>>>>>>> theirs\n}\n');
    }
    {
        // Not JSON on one side: the driver hands the file to git's line merge,
        // which merges these two far-apart edits cleanly.
        const base = '{\n  "A": "1",\n  "B": "2",\n  "C": "3",\n  "D": "4",\n  "E": "5",\n  "F": "6"\n}\n';
        const one = '{\n  "A": "1 (edited)",,\n  "B": "2",\n  "C": "3",\n  "D": "4",\n  "E": "5",\n  "F": "6"\n}\n';
        const two = '{\n  "A": "1",\n  "B": "2",\n  "C": "3",\n  "D": "4",\n  "E": "5",\n  "F": "6 (edited)"\n}\n';
        const { dir, file } = repo(base, one, two);
        const m = git(dir, 'merge', '--no-edit', 'two');
        check('a side that is not JSON falls back to the line merge, and says so', m.status === 0 && /merging by line instead/.test(m.out), m.out);
        eq('…whose result is git\'s own',
            read(file), '{\n  "A": "1 (edited)",,\n  "B": "2",\n  "C": "3",\n  "D": "4",\n  "E": "5",\n  "F": "6 (edited)"\n}\n');
    }
    {
        // A checkout without the driver script (a branch made before it): the
        // registered command runs git's line merge instead of failing.
        const one = '{\n  "Apple": "a",\n  "Banana": "b",\n  "Cherry": "c"\n}\n';
        const two = '{\n  "Apple": "a",\n  "Blueberry": "bb",\n  "Cherry": "c"\n}\n';
        const { dir, file } = repo(BASE, one, two, { dropDriverOnOne: true });
        const m = git(dir, 'merge', '--no-edit', 'two');
        check('in a checkout without the script, the merge is git\'s line merge', m.status !== 0 && conflicted(dir) === 'src/locales/x.json', m.out);
        eq('…with both sides in its markers, nothing dropped',
            read(file), '{\n  "Apple": "a",\n<<<<<<< ours\n  "Banana": "b",\n=======\n  "Blueberry": "bb",\n>>>>>>> theirs\n  "Cherry": "c"\n}\n');
    }

    console.log('\nregistration');
    {
        const dir = join(scratch, 'reg');
        mkdirSync(dir);
        must(dir, 'init', '-q');
        const first = registerLocaleMergeDriver(dir);
        const second = registerLocaleMergeDriver(dir);
        const all = git(dir, 'config', '--get-all', 'merge.locale-json.driver').out.trim();
        check('registering twice writes one entry, and the second run changes nothing',
            first.changed && !second.changed && all === DRIVER_COMMAND, all);
    }
} catch (err) {
    check('the suite ran to the end', false, err.stack || err.message);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
