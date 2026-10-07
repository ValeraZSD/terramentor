#!/usr/bin/env node
/**
 * The release workflows' decisions and files, as one script the gates can run.
 *
 *   node tools/release.mjs plan [--force] [--now ISO]      should the schedule publish main now, and as what
 *   node tools/release.mjs promote                         the stable release the latest nightly becomes
 *   node tools/release.mjs resolve                         what release.yml builds (event + inputs from env)
 *   node tools/release.mjs check-version --channel C --version V
 *   node tools/release.mjs stamp <version>                 write the version into package.json + lock
 *   node tools/release.mjs assets --dir release --channel C --version V --commit SHA
 *   node tools/release.mjs notes --channel C --version V --sha SHA [--since TAG] [--out FILE]
 *   node tools/release.mjs publish --dir release --version V --release-id ID --latest true|false
 *
 * `plan` and `promote` read the repository's releases from the GitHub API
 * (`GITHUB_TOKEN` if set, anonymous otherwise; `--releases-file` reads a saved
 * response instead) and everything else from git in the current directory, so
 * run them from a full clone with tags. Answers go to stdout as `key=value`
 * lines and, inside Actions, to `$GITHUB_OUTPUT` and the job summary.
 *
 * The decisions themselves are in tools/lib/releaseChannel.mjs; this file only
 * collects their inputs. Run `plan` on your own machine to see what the next
 * scheduled run would do: it publishes nothing.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
    buildManifest, checkBuildVersion, highestStable, isSemver, latestNightly, nightlyBase, nightlyDecision,
    nightlyNotes, nightlyVersion, promotion, releaseBody, releasePlan, sha256sums, stampedPackage, utcDate, assetPlatform,
    draftProblems,
} from './lib/releaseChannel.mjs';
import { repoSlug } from '../server/version.js';

const [command, ...rest] = process.argv.slice(2);
const args = { _: [] };
for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
}

function git(...gitArgs) {
    const r = spawnSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git ${gitArgs.join(' ')}: ${(r.stderr || '').trim()}`);
    return r.stdout.trim();
}
const gitOk = (...gitArgs) => spawnSync('git', gitArgs, { encoding: 'utf8' }).status === 0;
const gitTry = (...gitArgs) => { try { return git(...gitArgs); } catch { return null; } };

const repo = () => args.repo || process.env.GITHUB_REPOSITORY || repoSlug();
const tagsHere = () => git('tag', '-l').split('\n').map((t) => t.trim()).filter(Boolean);
const commitOf = (tag) => {
    const sha = gitTry('rev-parse', `${tag}^{commit}`);
    if (!sha) throw new Error(`${tag} is a published release but not a tag in this clone; fetch the tags (actions/checkout with fetch-depth: 0).`);
    return sha;
};

/** One GitHub API call for this repository, with GITHUB_TOKEN when there is
 *  one. GITHUB_API_URL is what Actions itself sets; the gates point it at a
 *  local stand-in. */
async function github(path, { method = 'GET', body } = {}) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const api = process.env.GITHUB_API_URL || 'https://api.github.com';
    const res = await fetch(`${api}/repos/${repo()}${path}`, {
        method,
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'terramentor-release',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} to ${method} ${path}`);
    return res.status === 204 ? null : res.json();
}

async function releases() {
    if (args['releases-file']) return JSON.parse(readFileSync(args['releases-file'], 'utf8'));
    // One page of the newest hundred is enough: the newest nightly is among
    // them unless a hundred stable releases came after it.
    return github('/releases?per_page=100');
}

/** A failed run of the Nightly workflow on this commit, as "<url> at <time>",
 *  or null. Unknown (no permission, no network) reads as none: the backoff
 *  saves emails and runner time, and must never be why a nightly is skipped. */
async function failedRunOn(sha) {
    try {
        const body = args['runs-file']
            ? JSON.parse(readFileSync(args['runs-file'], 'utf8'))
            : await github(`/actions/workflows/nightly.yml/runs?head_sha=${sha}&status=failure&per_page=1`);
        const run = body?.workflow_runs?.[0];
        return run ? `${run.html_url} at ${run.created_at}` : null;
    } catch (e) {
        process.stderr.write(`could not read earlier runs (${e.message}); not backing off\n`);
        return null;
    }
}

/** Print the answers, and hand them to the workflow when there is one. */
function answer(values, summary) {
    const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
    if (summary && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

async function plan() {
    const now = args.now ? Date.parse(args.now) : Date.now();
    const headSha = args.sha || git('rev-parse', 'HEAD');
    const tags = tagsHere();
    const packageVersion = JSON.parse(git('show', `${headSha}:package.json`)).version;
    const found = latestNightly(await releases());
    let last = null, lastIsAncestor = false;
    if (found) {
        last = { ...found, sha: commitOf(found.tag) };
        lastIsAncestor = gitOk('merge-base', '--is-ancestor', last.sha, headSha);
    }
    const failedOnHead = args.force ? null : await failedRunOn(headSha);
    const decision = nightlyDecision({ last, headSha, lastIsAncestor, now, force: !!args.force, failedOnHead });
    const version = nightlyVersion({ base: nightlyBase({ packageVersion, tags }), date: utcDate(now), tags });
    const stable = highestStable(tags);
    const previous = last?.tag || (stable ? `v${stable}` : '');
    answer(
        { publish: decision.publish, version, ref: headSha, previous, reason: decision.reason },
        `### Nightly\n\n${decision.publish ? '**Publishing**' : '**Skipping**'} \`${version}\` from \`${headSha.slice(0, 7)}\`: ${decision.reason}\n`,
    );
    if (decision.stuck) {
        process.stderr.write(`${process.env.GITHUB_ACTIONS ? '::error::' : ''}${decision.reason}\n`);
        process.exitCode = 1;
    }
}

async function promote() {
    const tags = tagsHere();
    const found = latestNightly(await releases());
    const nightly = found ? { tag: found.tag, sha: commitOf(found.tag) } : null;
    const main = args.main || (gitOk('rev-parse', '--verify', '--quiet', 'origin/main') ? 'origin/main' : 'HEAD');
    const onMain = !!nightly && gitOk('merge-base', '--is-ancestor', nightly.sha, main);
    const at = (file) => (nightly ? gitTry('show', `${nightly.sha}:${file}`) : null);
    const p = promotion({
        nightly,
        onMain,
        packageVersion: nightly ? JSON.parse(at('package.json') || '{}').version : null,
        tags,
        changelog: at('CHANGELOG.md') || '',
    });
    answer(
        { publish: true, version: p.version, ref: p.sha, previous: p.from, reason: `Promoting ${p.from} (${p.sha}) as ${p.tag}.` },
        `### Stable\n\nPromoting **${p.from}** (\`${p.sha.slice(0, 7)}\`) as **${p.tag}**.\n`,
    );
}

/** release.yml's plan: what this run builds, read from the event and the
 *  workflow_call inputs in the environment. */
function resolve() {
    const env = process.env;
    const candidate = env.IN_VERSION ? env.IN_REF : env.GITHUB_SHA;
    const main = gitOk('rev-parse', '--verify', '--quiet', 'origin/main') ? 'origin/main' : 'HEAD';
    const { movingTags, ...plan } = releasePlan({
        event: env.GITHUB_EVENT_NAME,
        refName: env.GITHUB_REF_NAME,
        sha: env.GITHUB_SHA,
        input: { channel: env.IN_CHANNEL, version: env.IN_VERSION, ref: env.IN_REF, previous: env.IN_PREVIOUS },
        dry: { version: env.DRY_VERSION, previous: env.DRY_PREVIOUS },
        tags: tagsHere(),
        onMain: !!candidate && gitOk('merge-base', '--is-ancestor', candidate, main),
    });
    answer({ ...plan, moving_tags: movingTags.join(' '), built_at: git('show', '-s', '--format=%cI', plan.ref) });
}

/** The files a release carries: the zips, SHA256SUMS and manifest.json in `dir`. */
async function releaseFiles(dir, version) {
    const names = readdirSync(dir).filter((n) => assetPlatform(n, version) || n === 'SHA256SUMS' || n === 'manifest.json');
    const files = [];
    for (const name of names) files.push({ name, size: statSync(join(dir, name)).size, sha256: await sha256(join(dir, name)) });
    return files;
}

/**
 * Make the draft release public, after checking that every file built here
 * is attached to it intact. Leftover drafts of the same tag (from an attempt
 * that failed after creating its draft) are deleted first, so the release a
 * reader finds is the one that was checked.
 */
async function publish() {
    const id = Number(args['release-id']);
    if (!Number.isInteger(id) || id <= 0) throw new Error('--release-id is required');
    const release = await github(`/releases/${id}`);
    const problems = draftProblems({ release, files: await releaseFiles(args.dir, args.version) });
    if (problems.length) throw new Error(`Not publishing ${release?.tag_name}: ${problems.join('; ')}`);
    for (const other of await releases()) {
        if (other.draft && other.tag_name === release.tag_name && other.id !== id) {
            await github(`/releases/${other.id}`, { method: 'DELETE' });
            process.stdout.write(`deleted a leftover draft of ${other.tag_name} (${other.id})\n`);
        }
    }
    await github(`/releases/${id}`, { method: 'PATCH', body: { draft: false, make_latest: args.latest === 'true' ? 'true' : 'false' } });
    answer({ published: release.tag_name }, `### Published\n\n${release.tag_name}, every file checked against this build.\n`);
}

function checkVersion() {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const reason = checkBuildVersion({ channel: args.channel, version: args.version, packageVersion: pkg.version });
    if (reason) throw new Error(reason);
    process.stdout.write(`${args.channel} ${args.version} agrees with package.json ${pkg.version}\n`);
}

function stamp() {
    const version = args._[0];
    if (!isSemver(version)) throw new Error(`"${version}" is not a semver version`);
    const out = stampedPackage({
        packageJson: readFileSync('package.json', 'utf8'),
        packageLock: readFileSync('package-lock.json', 'utf8'),
        version,
    });
    writeFileSync('package.json', out.packageJson);
    writeFileSync('package-lock.json', out.packageLock);
    process.stdout.write(`package.json and package-lock.json now say ${version}\n`);
}

const sha256 = (file) => new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

async function assets() {
    const dir = args.dir;
    const zips = readdirSync(dir).filter((n) => assetPlatform(n, args.version));
    if (!zips.length) throw new Error(`No Terramentor-${args.version}-<platform>.zip in ${dir}`);
    const files = [];
    for (const name of zips) files.push({ name, size: statSync(join(dir, name)).size, sha256: await sha256(join(dir, name)) });
    const manifest = buildManifest({
        repo: repo(), channel: args.channel, version: args.version, commit: args.commit,
        builtAt: args['built-at'] || new Date().toISOString(), files,
    });
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const own = { name: 'manifest.json', size: statSync(join(dir, 'manifest.json')).size, sha256: await sha256(join(dir, 'manifest.json')) };
    writeFileSync(join(dir, 'SHA256SUMS'), sha256sums([...files, own]));
    const table = files.map((f) => `| ${f.name} | ${(f.size / 1e6).toFixed(1)} MB | \`${f.sha256.slice(0, 16)}…\` |`).join('\n');
    answer({ manifest: join(dir, 'manifest.json') }, `### Assets\n\n| file | size | sha256 |\n|---|---|---|\n${table}\n`);
}

/** The release body: CHANGELOG section (stable) or commits since the last
 *  nightly (nightly), then the install text for this exact tag. */
function notes() {
    const channel = args.channel || 'nightly';
    let nightlyText = '';
    if (channel === 'nightly') {
        const since = args.since && gitOk('rev-parse', '--verify', '--quiet', `${args.since}^{commit}`) ? args.since : null;
        const range = since ? `${since}..${args.sha}` : args.sha;
        const log = git('log', '--no-merges', '--format=%H%x09%s', ...(since ? [] : ['-n', '30']), range);
        const commits = log ? log.split('\n').map((l) => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t') }; }) : [];
        nightlyText = nightlyNotes({ version: args.version, sha: args.sha, since, commits });
    }
    const changelog = channel === 'stable' ? gitTry('show', `${args.sha}:CHANGELOG.md`) || '' : '';
    const body = releaseBody({ channel, version: args.version, repo: repo(), changelog, nightlyText });
    if (args.out) writeFileSync(args.out, body);
    else process.stdout.write(body);
}

// exitCode, never exit(): after a fetch, ending the process while its socket is
// still closing trips a libuv assertion on Windows and turns a clean refusal
// into a crash with the wrong exit code.
const commands = { plan, promote, resolve, 'check-version': checkVersion, stamp, assets, notes, publish };
if (!commands[command]) {
    process.stderr.write(`usage: node tools/release.mjs ${Object.keys(commands).join('|')} …\n`);
    process.exitCode = 2;
} else {
    try {
        await commands[command]();
    } catch (e) {
        process.stderr.write(`${process.env.GITHUB_ACTIONS ? '::error::' : ''}${e.message}\n`);
        process.exitCode = 1;
    }
}
