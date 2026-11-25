#!/usr/bin/env node
/**
 * A git merge driver for `src/locales/*.json`: merges by KEY, not by line.
 *
 * Two branches that each add a sentence to the interface each add a key to
 * every locale file. A line merge conflicts whenever the two keys sort next to
 * each other; this driver reads the three versions as JSON and takes, per key,
 * the side that changed it:
 *
 *   - changed on one side only (added, edited or deleted): that side's version;
 *   - changed the same way on both sides: that version;
 *   - changed differently on both sides (two values, or a deletion against an
 *     edit): a conflict. The file is written with the usual conflict markers
 *     around that key's line only, the keys are printed, and the driver exits
 *     non-zero so git marks the file conflicted.
 *
 * The merged file is written by the locale writer (`tools/lib/localeJson.mjs`),
 * so it comes out sorted. A version that is not a flat JSON object of strings
 * (a half-edited file, conflict markers left in it) is not guessed at: the
 * driver runs git's own line merge (`git merge-file`) and returns its result.
 *
 * Git calls it as `node tools/locale-merge.mjs %O %A %B %P` (base, ours,
 * theirs, path) and reads the result from %A. Two things wire it up:
 * `.gitattributes` names the driver for `src/locales/*.json`, and
 * `merge.locale-json.driver` in the repository's config says what to run.
 * `node tools/locale-merge.mjs --register` writes that config (so does
 * `tools/worktree-setup.mjs`); without it git merges these files line by line
 * as it always has. Git reads `.gitattributes` from the checkout it merges
 * into, so the driver runs when the checkout has this file: to merge main into
 * a branch made before it existed, check out main and merge the branch there.
 *
 * GitHub's "Update branch" button runs no merge drivers.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneLinePerKey, serialiseLike } from './lib/localeJson.mjs';

export const DRIVER = 'locale-json';

/**
 * The command git runs. The checkout git merges in may predate this file (an
 * old branch), and the shell git starts may have no `node` (a GUI client), so
 * the command falls back to git's own line merge when either is missing. A
 * failed start would leave %A as our side alone, marked conflicted but with
 * no markers, and resolving that by `git add` would drop the other side.
 */
export const DRIVER_COMMAND = 'if test -f tools/locale-merge.mjs && command -v node >/dev/null 2>&1; '
    + 'then node tools/locale-merge.mjs %O %A %B %P; '
    + 'else git merge-file -L ours -L base -L theirs %A %O %B; fi';

const same = (a, b) => a === b;

/** Parse one version: a flat object of strings, one entry per line, or null.
 *  An empty base is an empty object (both sides added the file). A key that
 *  appears twice is null too: JSON.parse would keep only the last value. */
export function parseLocale(text, { emptyIsObject = false } = {}) {
    if (emptyIsObject && text.trim() === '') return {};
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (!Object.values(data).every((v) => typeof v === 'string')) return null;
    return oneLinePerKey(text, data) ? data : null;
}

/**
 * The three-way merge of three locale objects.
 * Returns { merged, conflicts } where `merged` holds every settled key and
 * `conflicts` lists { key, ours, theirs } (undefined = deleted on that side).
 */
export function mergeLocales(base, ours, theirs) {
    // Entries, then fromEntries: a key named "__proto__" stays a key.
    const entries = [];
    const conflicts = [];
    const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
    for (const key of keys) {
        const o = Object.hasOwn(base, key) ? base[key] : undefined;
        const a = Object.hasOwn(ours, key) ? ours[key] : undefined;
        const b = Object.hasOwn(theirs, key) ? theirs[key] : undefined;
        let value;
        if (same(a, b)) value = a;
        else if (same(a, o)) value = b;
        else if (same(b, o)) value = a;
        else { conflicts.push({ key, ours: a, theirs: b }); continue; }
        if (value !== undefined) entries.push([key, value]);
    }
    return { merged: Object.fromEntries(entries), conflicts };
}

/**
 * The merged file with conflict markers around each conflicting key's line.
 * Written through the locale writer, then each conflicting key's line is
 * replaced by the two sides' lines (a side that deleted the key is empty).
 */
export function conflictText(merged, conflicts, like) {
    const eol = like.includes('\r\n') ? '\r\n' : '\n';
    const byKey = new Map(conflicts.map((c) => [c.key, c]));
    const withAll = Object.fromEntries([...Object.entries(merged), ...conflicts.map((c) => [c.key, c.ours ?? c.theirs])]);
    const lines = serialiseLike(withAll, '\n').split('\n');
    const out = [];
    for (const line of lines) {
        const m = /^ {2}("(?:[^"\\]|\\.)*"): /.exec(line);
        const c = m && byKey.get(JSON.parse(m[1]));
        if (!c) { out.push(line); continue; }
        const comma = line.endsWith(',') ? ',' : '';
        const entry = (v) => (v === undefined ? [] : [`  ${JSON.stringify(c.key)}: ${JSON.stringify(v)}${comma}`]);
        out.push('<<<<<<< ours', ...entry(c.ours), '=======', ...entry(c.theirs), '>>>>>>> theirs');
    }
    return out.join(eol);
}

/** Merge the files git hands over; returns the exit code. */
export function mergeFiles(basePath, oursPath, theirsPath, label = oursPath) {
    const baseText = readFileSync(basePath, 'utf8');
    const oursText = readFileSync(oursPath, 'utf8');
    const theirsText = readFileSync(theirsPath, 'utf8');
    const base = parseLocale(baseText, { emptyIsObject: true });
    const ours = parseLocale(oursText);
    const theirs = parseLocale(theirsText);
    if (!base || !ours || !theirs) {
        const which = [!base && 'base', !ours && 'ours', !theirs && 'theirs'].filter(Boolean).join(', ');
        process.stderr.write(`locale-merge: ${label}: ${which} is not a flat JSON object of strings; merging by line instead\n`);
        const r = spawnSync('git', ['merge-file', '-L', 'ours', '-L', 'base', '-L', 'theirs', oursPath, basePath, theirsPath], { stdio: 'inherit' });
        return r.status === 0 ? 0 : 1;
    }
    const { merged, conflicts } = mergeLocales(base, ours, theirs);
    if (!conflicts.length) {
        writeFileSync(oursPath, serialiseLike(merged, oursText));
        return 0;
    }
    writeFileSync(oursPath, conflictText(merged, conflicts, oursText));
    process.stderr.write(`locale-merge: ${label}: ${conflicts.length} ${conflicts.length === 1 ? 'key' : 'keys'} changed on both sides:\n`);
    for (const c of conflicts) {
        const show = (v) => (v === undefined ? '(deleted)' : JSON.stringify(v).slice(0, 80));
        process.stderr.write(`  ${JSON.stringify(c.key).slice(0, 80)}\n    ours   ${show(c.ours)}\n    theirs ${show(c.theirs)}\n`);
    }
    return 1;
}

/** Write `merge.locale-json.*` into the repository's config at `root` (the
 *  config every worktree of it shares). Does nothing when it is already set. */
export function registerLocaleMergeDriver(root) {
    const get = spawnSync('git', ['config', '--get', `merge.${DRIVER}.driver`], { cwd: root, encoding: 'utf8' });
    if (get.status === 0 && get.stdout.replace(/\r?\n$/, '') === DRIVER_COMMAND) return { changed: false };
    for (const [k, v] of [[`merge.${DRIVER}.name`, 'locale files, merged by key'], [`merge.${DRIVER}.driver`, DRIVER_COMMAND]]) {
        const set = spawnSync('git', ['config', '--replace-all', k, v], { cwd: root, encoding: 'utf8' });
        if (set.status !== 0) throw new Error(`git config ${k} failed: ${(set.stderr || '').trim()}`);
    }
    return { changed: true };
}

const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
if (process.argv[1] && real(resolve(process.argv[1])).toLowerCase() === real(fileURLToPath(import.meta.url)).toLowerCase()) {
    const args = process.argv.slice(2);
    if (args[0] === '--register') {
        const root = resolve(fileURLToPath(import.meta.url), '..', '..');
        const r = registerLocaleMergeDriver(root);
        console.log(r.changed ? `merge.${DRIVER}.driver registered` : `merge.${DRIVER}.driver already registered`);
        process.exit(0);
    }
    if (args.length < 3) {
        process.stderr.write('usage: node tools/locale-merge.mjs <base> <ours> <theirs> [path] | --register\n');
        process.exit(2);
    }
    process.exit(mergeFiles(args[0], args[1], args[2], args[3] || args[1]));
}
